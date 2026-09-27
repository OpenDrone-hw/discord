import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import discord_config as dc  # noqa: E402
from fake_discord import GID, FakeDiscord, base_state  # noqa: E402

P = dc.PERMISSIONS

PROFILES = {
    "community": {  # gating model A: onboarding is the gate, @everyone is granted directly
        "@everyone": {"allow": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "USE_APPLICATION_COMMANDS"],
                      "deny": ["MENTION_EVERYONE"]},
    },
    "open": {
        "@everyone": {"allow": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "USE_APPLICATION_COMMANDS"]},
    },
    "staff": {"@everyone": {"deny": ["VIEW_CHANNEL"]}, "admin": {"allow": ["VIEW_CHANNEL"]}},
    "archive": {
        "@everyone": {"allow": ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"],
                      "deny": ["SEND_MESSAGES", "ADD_REACTIONS", "CREATE_PUBLIC_THREADS", "SEND_MESSAGES_IN_THREADS"]},
    },
}
# The superseded step-2 model: Member-gated channels. The lockout guard refuses it on managed channels.
MEMBER_GATED = {
    "@everyone": {"deny": ["VIEW_CHANNEL"]},
    "Newbie": {"deny": ["VIEW_CHANNEL", "SEND_MESSAGES"]},
    "Member": {"allow": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "USE_APPLICATION_COMMANDS"]},
}


def minimal_desired(**extra):
    d = {"guild_id": GID, "profiles": copy.deepcopy(PROFILES),
         "categories": [{"id": "100", "name": "Chats", "access": "community",
                         "channels": [{"id": "101", "name": "gen-chat"}, {"id": "102", "name": "builds"}]}]}
    d.update(extra)
    return d


def full_desired():
    """Every feature at once, shaped like the target OpenDrone layout."""
    return {
        "guild_id": GID,
        "guild": {"description": "Open source FPV stack", "rules_channel": "rules",
                  "public_updates_channel": "announcements"},
        "guard": {"protected_channels": ["202"]},
        "profiles": copy.deepcopy(PROFILES),
        "roles": [
            {"name": "Contributor", "color": "#3498db", "hoist": True, "mentionable": False, "permissions": []},
            {"name": "OpenFC", "color": 0x2ECC71, "mentionable": True},
            {"name": "FPV", "color": "#e74c3c"},
        ],
        "categories": [
            {"id": "100", "name": "Chats", "access": "open", "channels": [
                {"id": "101", "name": "gen-chat", "topic": "General chat", "slowmode": 5},
                {"name": "builds", "type": "forum", "topic": "Show your build",
                 "forum": {"layout": "gallery", "sort": "creation", "default_reaction": ":fpv:",
                           "tags": [{"name": "5 inch"}, {"name": "whoop", "emoji": ":quad:"}]}},
                {"name": "git-feed", "type": "announcement"},
            ]},
            {"name": "Development", "access": "community", "channels": [
                {"name": "dev-flight-controllers", "type": "forum",
                 "forum": {"require_tag": True, "post_slowmode": 10,
                           "tags": [{"name": "OpenFC", "emoji": "\U0001F6E0"}, {"name": "alpha", "moderated": True}]}},
                {"name": "dev-call", "type": "voice", "bitrate": 64000, "user_limit": 10},
                {"name": "community-call", "type": "stage"},
            ]},
            {"id": "200", "name": "Help", "access": "open", "channels": [
                {"id": "201", "name": "support"},
                {"name": "mod-log", "access": "staff"},
            ]},
        ],
        "archive": {"category": "Archive", "access": "archive", "channels": ["roles", "102"]},
        "onboarding": {
            "enabled": True, "mode": "advanced",
            "default_channels": ["welcome", "rules", "announcements", "gen-chat", "Chats/builds", "support", "git-feed"],
            "prompts": [
                {"title": "Where are you from?", "single_select": True, "required": True, "options": [
                    {"title": "Europe", "emoji": "\U0001F1EA\U0001F1FA", "roles": ["Europe", "Member"]},
                    {"title": "Asia", "emoji": "\U0001F43C", "roles": ["Member"]},
                ]},
                {"title": "What do you fly?", "options": [{"title": "FPV", "emoji": ":fpv:", "roles": ["FPV"]}]},
                {"title": "Follow development", "options": [
                    {"title": "Flight controllers", "description": "OpenFC", "roles": ["OpenFC"],
                     "channels": ["dev-flight-controllers"]}]},
            ],
        },
        "welcome_screen": {"description": "Open hardware FPV", "channels": [
            {"channel": "rules", "description": "Read first", "emoji": "\U0001F4DC"},
            {"channel": "Chats/builds", "description": "Builds", "emoji": ":fpv:"},
        ]},
        "automod": [
            {"name": "Block Mention Spam", "trigger": "mention_spam", "metadata": {"mention_total_limit": 10},
             "actions": [{"type": "block"}, {"type": "alert", "channel": "mod-log"}]},
            {"name": "Slurs", "trigger": "keyword_preset", "metadata": {"presets": ["slurs"]},
             "actions": [{"type": "block", "message": "Not here."}]},
            {"name": "Invite links", "trigger": "keyword", "metadata": {"regex_patterns": ["discord\\.gg/"]},
             "actions": [{"type": "block"}, {"type": "timeout", "seconds": 60}], "exempt_roles": ["admin"]},
        ],
    }


class ToolCase(unittest.TestCase):
    """Runs the real commands against FakeDiscord with snapshots in a temporary folder."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.object(dc, "SNAPSHOTS", Path(self.tmp.name) / "snapshots")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fake = FakeDiscord(base_state())

    def plan(self, desired, fake=None):
        return dc.build_plan(desired, dc.fetch(fake or self.fake, GID))

    def run_cli(self, desired, *argv, fake=None):
        path = Path(self.tmp.name) / "server.json"
        path.write_text(json.dumps(desired), encoding="utf-8")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = dc.main(["--config", str(path), *argv], api=fake or self.fake)
        return code, out.getvalue(), err.getvalue()

    def apply(self, desired, fake=None):
        code, out, err = self.run_cli(desired, "apply", "--yes", fake=fake)
        self.assertEqual(code, 0, out + err)
        self.assertIn("read-back: the server matches server.json", out)
        return out

    def assertIdempotent(self, desired):
        self.apply(desired)
        again = self.plan(desired)
        self.assertEqual(again["total"], 0, "\n".join(dc.render_plan(again, True)))

    def assertConfigError(self, desired, fragment, fake=None):
        with self.assertRaises(dc.ConfigError) as ctx:
            self.plan(desired, fake)
        self.assertIn(fragment, str(ctx.exception))
