"""migrate.py against an offline server: the live shape from test_server_json with the layout live before
this one (empty forums next to the old text chats) applied, then server.json applied on top.

No network. Messages, pins, members and the audit log are simulated on top of FakeDiscord.
"""

import contextlib
import copy
import io
import json
import re
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from helpers import ROOT, dc
from fake_discord import FakeDiscord
from test_plan import FakeResponse
from test_server_json import BUILDS, DESIRED, FIRMWARE, GID, PROPOSALS, RESTORED, current_desired, fake_state, live_state

import migrate

NOW_MS = 1_790_000_000_000  # 2026-09-21
ROLLOUT_MS = migrate.parse_since(migrate.ROLLOUT_START)
DAY_MS = 86_400_000
BOT = "1553826696673759344"
FC = "1494783056026796262"
AIO = "1538618173354414190"
ESC = "1494782966302507118"
ROLES_CH = "1494780931498705057"
BETAFLIGHT_CH = "1494783023114096821"
MOTORS = "1550883427220197396"
_seq = iter(range(1, 1 << 22))


def sf(ms: int) -> str:
    return str(((ms - dc.DISCORD_EPOCH_MS) << 22) | next(_seq))


def msg(ms, author, content="hi", bot=False, **extra):
    user = {"id": author, "bot": True} if bot else {"id": author}
    m = {"id": sf(ms), "type": 0, "content": content, "author": user, "pinned": False}
    m.update(extra)
    return m


class MigrationFake(FakeDiscord):
    """FakeDiscord plus channel messages, pins and guild members."""

    def __init__(self, state):
        super().__init__(state)
        self.messages = {}  # channel id -> list of messages
        self.members = {}  # user id -> set of role ids
        self.audit = []  # audit log entries, any order

    def request(self, method, path, body=None):
        g = f"/guilds/{self.gid}"
        routes = [
            ("GET", r"/channels/(\d+)/messages\?limit=(\d+)(?:&before=(\d+))?", self.get_messages),
            ("GET", r"/channels/(\d+)/pins", self.get_pins),
            ("PATCH", r"/channels/(\d+)/messages/(\d+)", self.patch_message),
            ("DELETE", r"/channels/(\d+)/pins/(\d+)", self.delete_pin),
            ("POST", r"/channels/(\d+)/messages", self.post_message),
            ("PUT", r"/channels/(\d+)/pins/(\d+)", self.put_pin),
            ("GET", g + r"/audit-logs\?action_type=(\d+)&limit=(\d+)(?:&before=(\d+))?", self.get_audit),
            ("GET", g + r"/members/(\d+)", self.get_member),
            ("PUT", g + r"/members/(\d+)/roles/(\d+)", self.put_member_role),
            ("DELETE", g + r"/members/(\d+)/roles/(\d+)", self.delete_member_role),
        ]
        for verb, pattern, handler in routes:
            m = re.fullmatch(pattern, path)
            if verb == method and m:
                self.calls.append((method, path, copy.deepcopy(body)))
                self.body = copy.deepcopy(body)
                return handler(m)
        return super().request(method, path, body)

    def get_messages(self, m):
        self.chan(m.group(1))
        items = sorted(self.messages.get(m.group(1), []), key=lambda x: int(x["id"]), reverse=True)
        if m.group(3):
            items = [x for x in items if int(x["id"]) < int(m.group(3))]
        return copy.deepcopy(items[: int(m.group(2))])

    def get_pins(self, m):
        self.chan(m.group(1))
        items = [x for x in self.messages.get(m.group(1), []) if x["pinned"]]
        return copy.deepcopy(sorted(items, key=lambda x: int(x["id"]), reverse=True))

    def message(self, cid, mid):
        hit = [x for x in self.messages.get(cid, []) if x["id"] == mid]
        if not hit:
            raise dc.HTTPError("HTTP 404 Unknown Message", 404)
        return hit[0]

    def patch_message(self, m):
        msg = self.message(m.group(1), m.group(2))
        assert msg["author"]["id"] == self.bot_user_id, "the bot edits only its own messages"
        assert self.body["allowed_mentions"] == {"parse": []}
        msg["content"] = self.body["content"]
        return copy.deepcopy(msg)

    def delete_pin(self, m):
        self.message(m.group(1), m.group(2))["pinned"] = False

    def post_message(self, m):
        self.chan(m.group(1))
        assert self.body["allowed_mentions"] == {"parse": []}
        assert len(self.body["content"]) <= 2000
        posted = msg(NOW_MS, self.bot_user_id, self.body["content"], bot=True)
        self.messages.setdefault(m.group(1), []).append(posted)
        return copy.deepcopy(posted)

    def put_pin(self, m):
        self.message(m.group(1), m.group(2))["pinned"] = True

    def get_audit(self, m):
        assert m.group(1) == str(migrate.MEMBER_ROLE_UPDATE)
        items = sorted(self.audit, key=lambda e: int(e["id"]), reverse=True)
        if m.group(3):
            items = [e for e in items if int(e["id"]) < int(m.group(3))]
        return {"audit_log_entries": copy.deepcopy(items[: int(m.group(2))]), "users": []}

    def get_member(self, m):
        if m.group(1) not in self.members:
            raise dc.HTTPError("HTTP 404 Unknown Member", 404)
        return {"user": {"id": m.group(1)}, "roles": sorted(self.members[m.group(1)])}

    def put_member_role(self, m):
        if m.group(1) not in self.members:
            raise dc.HTTPError("HTTP 404 Unknown Member", 404)
        assert any(r["id"] == m.group(2) for r in self.roles), m.group(2)
        self.members[m.group(1)].add(m.group(2))

    def delete_member_role(self, m):
        if m.group(1) not in self.members:
            raise dc.HTTPError("HTTP 404 Unknown Member", 404)
        self.members[m.group(1)].discard(m.group(2))

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]

    def role_id(self, name):
        return self.role_by_name(name)["id"]


def applied(desired, state):
    fake = FakeDiscord(state)
    with tempfile.TemporaryDirectory() as tmp, mock.patch.object(dc, "SNAPSHOTS", Path(tmp)), \
            contextlib.redirect_stdout(io.StringIO()):
        path = Path(tmp) / "server.json"
        path.write_text(json.dumps(desired), encoding="utf-8")
        assert dc.main(["--config", str(path), "apply", "--yes"], api=fake) == 0
    return fake_state(fake)


CURRENT = applied(current_desired(), live_state())  # the live server before this layout
APPLIED = applied(DESIRED, copy.deepcopy(CURRENT))  # after `discord_config.py apply --yes` of server.json


def without_role(state, name):
    """A copy of a server state with one role missing, as before server.json created it."""
    state = copy.deepcopy(state)
    state["roles"] = [r for r in state["roles"] if r["name"] != name]
    return state


class Case(unittest.TestCase):
    def setUp(self):
        self.fake = MigrationFake(copy.deepcopy(APPLIED))
        self.sleeps = []

    def run_cli(self, *argv, fake=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = migrate.main(["--config", str(ROOT / "server.json"), *argv], api=fake or self.fake,
                                sleep=self.sleeps.append, clock=lambda: NOW_MS / 1000)
        return code, out.getvalue(), err.getvalue()

    def ok(self, *argv, fake=None):
        code, out, err = self.run_cli(*argv, fake=fake)
        self.assertEqual(code, 0, out + err)
        return out

    def channel_id(self, category, name):
        cat = next(c["id"] for c in self.fake.channels if c["type"] == 4 and c["name"] == category)
        return next(c["id"] for c in self.fake.channels if c["name"] == name and c.get("parent_id") == cat)


def notice(cid, pinned=True):
    return msg(NOW_MS - 2 * DAY_MS, BOT, f"**This channel is archived.** {cid}\n-# {migrate.NOTICE_MARK}",
               bot=True, pinned=pinned)


class Mapping(unittest.TestCase):
    def test_every_restored_channel_has_one_entry(self):
        self.assertEqual(set(migrate.CHATS), set(RESTORED))

    def test_names_match_server_json_and_the_live_shape(self):
        live = {c["id"]: c["name"] for c in live_state()["channels"]}
        for cid, (old, name, *_rest) in migrate.CHATS.items():
            self.assertEqual(live[cid], old)
            self.assertEqual(RESTORED[cid][1], name)

    def test_ping_roles_come_from_the_onboarding_option_for_the_channel(self):
        options = [o for p in DESIRED["onboarding"]["prompts"] for o in p["options"]]
        for cid, (_old, name, _line, role) in migrate.CHATS.items():
            if role:
                self.assertTrue(any(role in o.get("roles", []) and name in o.get("channels", [])
                                    for o in options), (name, role))

    def test_no_ping_role_is_a_firmware_team_role(self):
        self.assertFalse({chat[3] for chat in migrate.CHATS.values()} & set(FIRMWARE))
        self.assertEqual(migrate.FIRMWARE_ROLES, FIRMWARE)

    def test_repos_json_is_the_bots(self):
        repos = migrate.load_repos()
        self.assertLessEqual(set(migrate.PRIVATE_REPOS), set(repos["repos"]))
        self.assertEqual(tuple(repos["lifecycle"]), migrate.LIFECYCLE_TOPICS)


class Unarchive(Case):
    def seed(self):
        for cid in migrate.CHATS:
            self.fake.messages[cid] = [msg(NOW_MS - 3 * DAY_MS, "42"), notice(cid)]

    def test_dry_run_writes_nothing(self):
        self.seed()
        out = self.ok("unarchive")
        self.assertEqual(self.fake.writes(), [])
        self.assertIn("unarchive: 18 to update, 0 done, 0 without a notice, 0 blocked", out)
        self.assertIn("Chat for flight controllers. Pull requests in the public repositories of this line get a thread "
                      "here.", out)
        self.assertIn("Dry run", out)

    def test_edits_and_unpins_each_notice_once(self):
        self.seed()
        self.ok("unarchive", "--yes")
        edits = [c for c in self.fake.writes() if c[0] == "PATCH"]
        unpins = [c for c in self.fake.writes() if c[0] == "DELETE"]
        self.assertEqual((len(edits), len(unpins), len(self.fake.writes())), (18, 18, 36))
        self.assertEqual(len(self.sleeps), 36)
        for _m, path, body in edits:
            self.assertEqual(body["allowed_mentions"], {"parse": []})
            self.assertNotIn("archived", body["content"])
            self.assertNotIn("<#", body["content"])  # the forums are gone; nothing links to them
            self.assertIn(migrate.UNARCHIVE_MARK, body["content"])
        for _m, path, body in unpins:
            self.assertRegex(path, r"^/channels/\d+/pins/\d+$")
            self.assertIsNone(body)
        for cid in migrate.CHATS:
            self.assertEqual(len(self.fake.messages[cid]), 2, cid)  # nothing deleted, nothing posted
            mine = [m for m in self.fake.messages[cid] if m["author"]["id"] == BOT]
            self.assertFalse(mine[0]["pinned"], cid)
        text = {path.split("/")[2]: body["content"] for _m, path, body in edits}
        self.assertEqual(text[FC], migrate.chat_text("flight controllers", True))
        self.assertTrue(text[BETAFLIGHT_CH].startswith("Chat for Betaflight. Pull requests"), text[BETAFLIGHT_CH])
        self.assertEqual(text[MOTORS], f"Chat for motors.\n-# {migrate.UNARCHIVE_MARK}")
        self.assertEqual(text[BUILDS], f"Chat for builds.\n-# {migrate.UNARCHIVE_MARK}")
        self.assertTrue(text[PROPOSALS].startswith("Chat for proposals for new products and changes."))
        self.assertTrue(text[ROLES_CH].startswith("Roles are picked in <id:customize>"), text[ROLES_CH])
        before = len(self.fake.writes())
        out = self.ok("unarchive", "--yes")
        self.assertEqual(len(self.fake.writes()), before)
        self.assertIn("unarchive: 0 to update, 18 done", out)

    def test_rewrites_a_notice_that_still_links_a_retired_forum(self):
        old = f"Chat for flight controllers. Structured posts, one per change, go in <#1553>.\n-# {migrate.UNARCHIVE_MARK}"
        self.fake.messages[FC] = [msg(NOW_MS - DAY_MS, BOT, old, bot=True)]
        self.ok("unarchive", "--yes")
        fc = [c for c in self.fake.writes() if f"/channels/{FC}/" in c[1]]
        self.assertEqual([c[0] for c in fc], ["PATCH"])
        self.assertEqual(self.fake.messages[FC][0]["content"], migrate.chat_text("flight controllers", True))

    def test_finds_an_unpinned_notice_in_history_and_only_edits_it(self):
        self.fake.messages[FC] = [notice(FC, pinned=False)] + [msg(NOW_MS - DAY_MS, "42") for _ in range(150)]
        self.ok("unarchive", "--yes")
        fc = [c for c in self.fake.writes() if f"/channels/{FC}/" in c[1]]
        self.assertEqual([c[0] for c in fc], ["PATCH"])

    def test_a_members_message_with_the_marker_is_not_touched(self):
        self.fake.messages[FC] = [msg(NOW_MS - DAY_MS, "42", "x\n-# " + migrate.NOTICE_MARK, pinned=True)]
        out = self.ok("unarchive", "--yes")
        self.assertEqual([c for c in self.fake.writes() if f"/channels/{FC}/" in c[1]], [])
        self.assertIn("#fc: no notice found", out)

    def test_blocked_before_the_layout_is_applied(self):
        fake = MigrationFake(copy.deepcopy(CURRENT))
        for cid in migrate.CHATS:
            fake.messages[cid] = [notice(cid)]
        out = self.ok("unarchive", fake=fake)
        self.assertIn("2 blocked", out)
        self.assertIn("blocked #builds: not yet #builds in Community", out)
        self.assertIn("blocked #proposals: not yet #proposals in Community", out)
        code, _out, _err = self.run_cli("unarchive", "--yes", fake=fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes(), [])


def role_update(ms, target, actor, added=(), removed=(), reason=None):
    changes = []
    if added:
        changes.append({"key": "$add", "new_value": [{"id": rid, "name": "x"} for rid in added]})
    if removed:
        changes.append({"key": "$remove", "new_value": [{"id": rid, "name": "x"} for rid in removed]})
    return {"id": sf(ms), "action_type": 25, "target_id": target, "user_id": actor, "changes": changes,
            "reason": reason}


class FirmwareRoles(Case):
    def seed(self):
        f = self.fake
        bf, am, elrs = (f.role_id(n) for n in FIRMWARE)
        fc_dev = f.role_id("FC dev")
        after = ROLLOUT_MS + 60_000
        f.audit = [
            role_update(after, "201", "201", [bf, am]),  # picked two in onboarding
            role_update(after + 1000, "202", BOT, [elrs], reason=migrate.AUDIT_REASON),  # backfill
            role_update(after + 1500, "209", BOT, [elrs], reason="OpenDrone-hw/discord bot"),  # other bot code
            role_update(after + 2000, "203", "203", [bf]),  # picked, left the server since
            role_update(after + 3000, "204", "999", [bf]),  # a moderator made a real maintainer
            role_update(after + 4000, "205", "205", [fc_dev]),  # not a firmware role
            role_update(after + 5000, "206", "206", removed=[bf]),  # a removal is not an add
            role_update(ROLLOUT_MS - 60_000, "207", "207", [am]),  # before the rollout
        ]
        f.audit += [role_update(after + 10_000 + i, "208", "208", [fc_dev]) for i in range(150)]  # paging
        f.members = {"201": {bf, am}, "202": {elrs}, "204": {bf}, "205": {fc_dev}, "206": set(), "207": {am}}

    def test_dry_run_counts_only(self):
        self.seed()
        out = self.ok("firmware-roles")
        self.assertEqual(self.fake.writes(), [])
        self.assertIn("Betaflight -> Betaflight user: 2 members to move (picked 2, backfill 0), "
                      "1 member given it by a moderator left alone", out)
        self.assertIn("AM32 -> AM32 user: 1 member to move (picked 1, backfill 0)", out)
        self.assertIn("ExpressLRS -> ExpressLRS user: 1 member to move (picked 0, backfill 1), "
                      "1 member given it by a moderator left alone", out)
        for uid in ("201", "202", "203", "204", "999"):
            self.assertNotRegex(out, rf"\b{uid}\b")
        audit = [c for c in self.fake.calls if "/audit-logs" in c[1]]
        self.assertEqual(len(audit), 2)
        self.assertIn("&before=", audit[1][1])

    def test_moves_team_roles_to_user_roles_once(self):
        self.seed()
        out = self.ok("firmware-roles", "--yes")
        f = self.fake
        role = f.role_id
        self.assertEqual(f.members["201"], {role("Betaflight user"), role("AM32 user")})
        self.assertEqual(f.members["202"], {role("ExpressLRS user")})
        self.assertEqual(f.members["204"], {role("Betaflight")})  # the moderator's grant stays
        self.assertEqual(f.members["207"], {role("AM32")})  # before --since
        self.assertIn("Betaflight: removed 1, not held 0; Betaflight user: granted 1, already held 0; "
                      "not in the server 1", out)
        self.assertEqual(len(self.sleeps), len(f.writes()))
        self.assertFalse(any(re.search(r"\b(201|202|203)\b", line) for line in out.splitlines()))
        before = len(f.writes())
        out = self.ok("firmware-roles", "--yes")
        self.assertEqual(len(f.writes()), before)
        self.assertIn("AM32: removed 0, not held 1; AM32 user: granted 0, already held 1", out)

    def test_since(self):
        self.seed()
        out = self.ok("firmware-roles", "--since", "2026-09-26T00:00:00Z")
        self.assertIn("AM32 -> AM32 user: 2 members to move", out)
        code, _out, err = self.run_cli("firmware-roles", "--since", "yesterday")
        self.assertEqual(code, 1)
        self.assertIn("not an ISO 8601 timestamp", err)

    def test_blocked_before_the_user_roles_exist(self):
        fake = MigrationFake(without_role(APPLIED, "Betaflight user"))
        out = self.ok("firmware-roles", fake=fake)
        self.assertIn("blocked: role Betaflight user does not exist", out)
        code, _out, _err = self.run_cli("firmware-roles", "--yes", fake=fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes(), [])


class Backfill(Case):
    def seed(self):
        # FC: five recent members, a bot, a webhook, a join message; one member only posted 100 days ago.
        fc = [msg(NOW_MS - (i % 80 + 1) * DAY_MS, f"10{i % 5}") for i in range(230)]
        fc += [msg(NOW_MS - DAY_MS, "900", bot=True),
               msg(NOW_MS - DAY_MS, "901", webhook_id="55"),
               msg(NOW_MS - DAY_MS, "902", type=7)]
        fc += [msg(NOW_MS - 100 * DAY_MS, "199") for _ in range(500)]
        self.fake.messages[FC] = fc
        self.fake.messages[ESC] = [msg(NOW_MS - 2 * DAY_MS, "100"), msg(NOW_MS - 3 * DAY_MS, "300")]
        for uid in ("100", "101", "102", "103", "104", "199", "900", "901", "902"):
            self.fake.members[uid] = set()
        self.fake.members["101"].add(self.fake.role_id("FC dev"))  # already holds it; "300" left the server

    def granted(self):
        return [(p.split("/")[4], p.split("/")[6]) for m, p, _b in self.fake.writes()]

    def test_dry_run_writes_nothing_and_prints_no_user_ids(self):
        self.seed()
        out = self.ok("backfill")
        self.assertEqual(self.fake.writes(), [])
        self.assertFalse(any(c[1].startswith(f"/guilds/{GID}/members") for c in self.fake.calls))
        self.assertIn("#fc -> FC dev: 230 member messages, 5 authors", out)
        self.assertIn("#esc -> ESC dev: 2 member messages, 2 authors", out)
        for uid in ("100", "101", "199", "300", "900"):
            self.assertNotRegex(out, rf"\b{uid}\b")

    def test_pagination_stops_at_the_cutoff(self):
        self.seed()
        self.ok("backfill", "--channel", "fc")
        pages = [c for c in self.fake.calls if c[1].startswith(f"/channels/{FC}/messages")]
        # 233 messages in the window: pages of 100, 100, then the third page reaches the 100-day-old ones.
        self.assertEqual(len(pages), 3)
        self.assertIn("&before=", pages[1][1])

    def test_grants_missing_roles_once(self):
        self.seed()
        out = self.ok("backfill", "--yes")
        fc, esc = self.fake.role_id("FC dev"), self.fake.role_id("ESC dev")
        self.assertEqual(sorted(self.granted()), sorted([("100", fc), ("102", fc), ("103", fc), ("104", fc),
                                                         ("100", esc)]))
        self.assertIn("FC dev: granted 4, already held 1, not in the server 0", out)
        self.assertIn("ESC dev: granted 1, already held 0, not in the server 1", out)
        self.assertNotIn(fc, self.fake.members["199"])
        self.assertEqual(self.sleeps, [migrate.WRITE_DELAY] * 5)
        before = len(self.fake.writes())
        out = self.ok("backfill", "--yes")
        self.assertEqual(len(self.fake.writes()), before)
        self.assertIn("FC dev: granted 0, already held 5", out)

    def test_single_user_mode(self):
        self.seed()
        out = self.ok("backfill", "--only-user", "100")
        self.assertIn("total: 1 member, at most 2 role grants", out)
        self.assertNotRegex(out, r"\b100\b")
        self.ok("backfill", "--only-user", "100", "--yes")
        self.assertEqual(sorted(self.granted()), sorted([("100", self.fake.role_id("FC dev")),
                                                         ("100", self.fake.role_id("ESC dev"))]))
        member_reads = {c[1] for c in self.fake.calls if c[0] == "GET" and c[1].startswith(f"/guilds/{GID}/members/")}
        self.assertEqual(member_reads, {f"/guilds/{GID}/members/100"})

    def test_single_user_without_messages_grants_nothing(self):
        self.seed()
        out = self.ok("backfill", "--only-user", "555", "--yes")
        self.assertIn("nothing to grant", out)
        self.assertEqual(self.fake.writes(), [])

    def test_days_and_channel_limits(self):
        self.seed()
        out = self.ok("backfill", "--days", "2", "--channel", "#esc")
        self.assertIn("#esc -> ESC dev: 1 member message, 1 author", out)
        self.assertNotIn("#fc", out)
        self.assertFalse(any(c[1].startswith(f"/channels/{FC}/") for c in self.fake.calls))
        code, _out, err = self.run_cli("backfill", "--channel", "motors")
        self.assertEqual(code, 1)
        self.assertIn("not a development chat with a ping role", err)

    def test_refuses_a_privileged_or_missing_role(self):
        self.seed()
        self.fake.role_by_name("FC dev")["permissions"] = str(dc.PERMISSIONS["MANAGE_MESSAGES"])
        code, _out, err = self.run_cli("backfill", "--yes")
        self.assertEqual(code, 1)
        self.assertIn("FC dev", err)
        self.assertEqual(self.fake.writes(), [])
        fake = MigrationFake(without_role(APPLIED, "Betaflight user"))
        fake.messages[BETAFLIGHT_CH] = [msg(NOW_MS - DAY_MS, "100")]
        out = self.ok("backfill", "--channel", "fc-betaflight", fake=fake)
        self.assertIn("Betaflight user: 1 member, role does not exist yet", out)
        code, _out, _err = self.run_cli("backfill", "--channel", "fc-betaflight", "--yes", fake=fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes(), [])


REPOS = migrate.load_repos()


class FakeGitHub:
    """GET repos/<org>/<name> answers from a dict; None (404) for anything else. Records every path."""

    def __init__(self):
        self.calls = []
        self.meta = {repo: {"private": False, "description": f"{repo}: an open  design\n",
                            "topics": ["kicad", "status-beta"]}
                     for repo in REPOS["repos"] if repo not in migrate.PRIVATE_REPOS}
        del self.meta["OpenRX-Mono"]  # 404: renamed or deleted
        self.meta["OpenDrone-Brand"]["private"] = True

    def __call__(self, path):
        self.calls.append(path)
        return copy.deepcopy(self.meta.get(path.rsplit("/", 1)[-1]))


class Hubs(Case):
    def setUp(self):
        super().setUp()
        self.github = FakeGitHub()

    def run_cli(self, *argv, fake=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = migrate.main(["--config", str(ROOT / "server.json"), *argv], api=fake or self.fake,
                                sleep=self.sleeps.append, clock=lambda: NOW_MS / 1000, fetch=self.github)
        return code, out.getvalue(), err.getvalue()

    def posts(self):
        return [c for c in self.fake.writes() if c[0] == "POST"]

    def test_dry_run_counts_only_and_writes_nothing(self):
        out = self.ok("hubs")
        self.assertEqual(self.fake.writes(), [])
        self.assertIn("hubs: 22 to post, 0 to edit, 22 to pin, 0 done; 5 private skipped, 1 not found on GitHub, "
                      "0 channel(s) blocked", out)
        self.assertIn("#fc: 2 hubs, 2 to post", out)
        self.assertIn("#kicad-library: 3 hubs, 3 to post", out)
        self.assertNotIn("#frame:", out)  # both frame repositories are private
        for repo in migrate.PRIVATE_REPOS:
            self.assertNotIn(f"repos/OpenDrone-hw/{repo}", self.github.calls)
        self.assertIn("Dry run", out)

    def test_posts_and_pins_one_hub_per_public_repository_once(self):
        self.ok("hubs", "--yes")
        posts = self.posts()
        pins = [c for c in self.fake.writes() if c[0] == "PUT"]
        self.assertEqual((len(posts), len(pins)), (22, 22))
        self.assertEqual(len(self.sleeps), 44)
        by_channel = {}
        for _m, path, body in posts:
            self.assertEqual(body["allowed_mentions"], {"parse": []})
            self.assertEqual(body["flags"], migrate.SUPPRESS_EMBEDS)
            by_channel.setdefault(path.split("/")[2], []).append(body["content"])
        self.assertEqual([t.split("\n")[0] for t in by_channel[FC]], [
            "## [OpenFC-Lite](https://github.com/OpenDrone-hw/OpenFC-Lite)",
            "## [OpenFC-Lite-Mini](https://github.com/OpenDrone-hw/OpenFC-Lite-Mini)"])
        self.assertEqual(by_channel[FC][0], "\n".join([
            "## [OpenFC-Lite](https://github.com/OpenDrone-hw/OpenFC-Lite)",
            "OpenFC-Lite: an open design",
            "Lifecycle: beta",
            "Releases: https://github.com/OpenDrone-hw/OpenFC-Lite/releases",
            "Discuss changes in threads: the bot opens one per pull request; link an existing thread with /link.",
            f"-# {migrate.HUB_MARK} OpenFC-Lite"]))
        kicad = self.channel_id("Hardware", "kicad-library")
        self.assertEqual(len(by_channel[kicad]), 3)
        self.assertFalse(any("OpenDrone-Brand" in t or "OpenRX-Mono" in t for ts in by_channel.values() for t in ts))
        self.assertTrue(all(m["pinned"] for cid in by_channel for m in self.fake.messages[cid]))
        before = len(self.fake.writes())
        out = self.ok("hubs", "--yes")
        self.assertEqual(len(self.fake.writes()), before)
        self.assertIn("hubs: 0 to post, 0 to edit, 0 to pin, 22 done", out)

    def test_edits_a_hub_whose_lifecycle_changed_and_repins_an_unpinned_one(self):
        self.ok("hubs", "--yes")
        self.github.meta["OpenFC-Lite"]["topics"] = ["status-planned", "status-launched"]
        mini = next(m for m in self.fake.messages[FC] if "OpenFC-Lite-Mini" in m["content"])
        mini["pinned"] = False
        before = len(self.fake.writes())
        out = self.ok("hubs", "--yes")
        new = self.fake.writes()[before:]
        self.assertEqual([c[0] for c in new], ["PATCH", "PUT"])
        self.assertIn("Lifecycle: launched", new[0][2]["content"])
        self.assertIn("#fc: 2 hubs, 0 to post, 1 to edit, 1 to pin, 0 done", out)

    def test_a_members_message_with_the_marker_is_not_taken_for_the_hub(self):
        fake_hub = f"x\n-# {migrate.HUB_MARK} OpenFC-Lite"
        self.fake.messages[FC] = [msg(NOW_MS - DAY_MS, "42", fake_hub, pinned=True)]
        out = self.ok("hubs")
        self.assertIn("#fc: 2 hubs, 2 to post", out)

    def test_blocked_before_the_layout_is_applied(self):
        fake = MigrationFake(copy.deepcopy(CURRENT))
        out = self.ok("hubs", fake=fake)
        self.assertIn("blocked #kicad-library: the channel does not exist yet", out)
        code, _out, err = self.run_cli("hubs", "--yes", fake=fake)
        self.assertEqual(code, 1)
        self.assertIn("Apply server.json first", err)
        self.assertEqual(fake.writes(), [])

    def test_hub_text(self):
        labels = REPOS["lifecycle"]
        text = migrate.hub_text("OpenDrone-hw", "X", {"description": "> A \u2014 B\u2014C", "topics": []}, labels)
        self.assertIn("\nA, B-C\nLifecycle: not set\n", text)
        text = migrate.hub_text("OpenDrone-hw", "X", {"topics": ["status-alpha", "status-planned"]}, labels)
        self.assertEqual(text.split("\n")[1], "Lifecycle: alpha")
        self.assertNotIn("\u2014", text)

    def test_gh_fetch_maps_404_to_none_and_refuses_other_errors(self):
        def run(returncode, stdout="", stderr=""):
            return mock.Mock(returncode=returncode, stdout=stdout, stderr=stderr)

        with mock.patch.object(migrate.subprocess, "run", return_value=run(0, '{"private": false}')) as call:
            self.assertEqual(migrate.gh_fetch("repos/OpenDrone-hw/X"), {"private": False})
            self.assertEqual(call.call_args[0][0], ["gh", "api", "repos/OpenDrone-hw/X"])
        with mock.patch.object(migrate.subprocess, "run", return_value=run(1, stderr="gh: Not Found (HTTP 404)")):
            self.assertIsNone(migrate.gh_fetch("repos/OpenDrone-hw/X"))
        with mock.patch.object(migrate.subprocess, "run", return_value=run(1, stderr="HTTP 401: Bad credentials")):
            with self.assertRaises(dc.ConfigError):
                migrate.gh_fetch("repos/OpenDrone-hw/X")


RULES_MD = """# Server copy

## 3. Resource pages

Not this.

## 4. #rules

```
**OpenDrone rules**

1. Argue about problems, not people.
2. Use the right channel.
```

---

## 5. Next section
"""


class Rules(Case):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def md(self, text=RULES_MD):
        path = Path(self.tmp.name) / "copy.md"
        path.write_text(text, encoding="utf-8")
        return str(path)

    def test_section_extraction(self):
        self.assertEqual(migrate.rules_section(RULES_MD),
                         "**OpenDrone rules**\n\n1. Argue about problems, not people.\n2. Use the right channel.")
        self.assertEqual(migrate.rules_section("### 4. #rules\nPlain text.\n\n---\n### 5. x\n"), "Plain text.")
        for bad, why in (("## 3. x\n", "no heading"), ("## 4. #rules\n\n## 5. x", "empty"),
                         ("## 4. #rules\nA \u2014 B\n", "em dash"), ("## 4. #rules\n> quoted\n", "blockquote")):
            with self.assertRaises(dc.ConfigError, msg=bad) as ctx:
                migrate.rules_section(bad)
            self.assertIn(why, str(ctx.exception))

    def test_dry_run_then_post_and_pin_once(self):
        rules = self.channel_id("Start", "rules")
        out = self.ok("rules", "--rules-file", self.md())
        self.assertEqual(self.fake.writes(), [])
        self.assertIn("rules: 1 message (83 characters), 1 to post, 0 to edit, 1 to pin, 0 done", out)
        self.assertIn("1. Argue about problems, not people.", out)
        self.ok("rules", "--rules-file", self.md(), "--yes")
        writes = self.fake.writes()
        self.assertEqual([(c[0], c[1].split("/")[2]) for c in writes], [("POST", rules), ("PUT", rules)])
        self.assertEqual(writes[0][2]["content"],
                         migrate.rules_section(RULES_MD) + f"\n-# {migrate.RULES_MARK} 1")
        out = self.ok("rules", "--rules-file", self.md(), "--yes")
        self.assertEqual(len(self.fake.writes()), 2)
        self.assertIn("0 to post, 0 to edit, 0 to pin, 1 done", out)
        self.ok("rules", "--rules-file", self.md(RULES_MD.replace("people.", "people, ever.")), "--yes")
        self.assertEqual([c[0] for c in self.fake.writes()[2:]], ["PATCH"])

    def test_long_rules_are_split_at_paragraphs(self):
        paragraphs = "\n\n".join(f"{i}. " + "x" * 900 for i in range(1, 4))
        out = self.ok("rules", "--rules-file", self.md(f"## 4. #rules\n\n{paragraphs}\n"), "--yes")
        self.assertIn("rules: 2 messages", out)
        posts = [c[2]["content"] for c in self.fake.writes() if c[0] == "POST"]
        self.assertEqual([p.rsplit("\n", 1)[1] for p in posts], [f"-# {migrate.RULES_MARK} 1", f"-# {migrate.RULES_MARK} 2"])
        self.assertTrue(posts[0].startswith("1. ") and posts[1].startswith("3. "))

    def test_a_bad_file_fails_before_any_request(self):
        code, _out, err = self.run_cli("rules", "--rules-file", self.md("nothing here"), fake=object())
        self.assertEqual(code, 1)
        self.assertIn('no heading "4. #rules"', err)
        code, _out, err = self.run_cli("rules", "--rules-file", str(Path(self.tmp.name) / "missing.md"), fake=object())
        self.assertEqual(code, 1)
        self.assertIn("--rules-file", err)


class Checklist(Case):
    def test_steps_in_order_without_a_token(self):
        out = self.ok("checklist", fake=object())
        order = ["discord_config.py apply --yes", "Delete the retired empty channels by hand",
                 "Paste the Server Guide copy", "migrate.py rules --rules-file <copy.md> --yes", "migrate.py hubs --yes",
                 "migrate.py unarchive --yes", "migrate.py firmware-roles --yes", "backfill --only-user",
                 "migrate.py backfill --yes", "carl-bot", "linked roles", "2FA"]
        positions = [out.index(part) for part in order]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("Welcome sign", out)


class Client(unittest.TestCase):
    def test_write_waits_out_a_429_then_the_write_delay_and_carries_the_audit_reason(self):
        requests, sleeps = [], []
        responses = {
            "/users/@me": [FakeResponse(b'{"id": "500"}')],
            f"/guilds/{GID}/channels": [FakeResponse(b"[]")],
            f"/guilds/{GID}/roles": [FakeResponse(b"[]")],
            "/channels/7/messages/8": [urllib.error.HTTPError("u", 429, "Too Many", {}, io.BytesIO(b'{"retry_after": 2}')),
                                       FakeResponse(b'{"id": "8"}')],
            "/channels/7/pins/8": [FakeResponse(b"")],
        }

        def urlopen(req, context=None, timeout=None):
            requests.append(req)
            item = responses[req.full_url.removeprefix(dc.API)].pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        api = migrate.client("TOKEN", urlopen=urlopen, sleep=sleeps.append)
        server = migrate.Server(api, DESIRED, sleep=sleeps.append)
        body = {"content": "hello", "allowed_mentions": {"parse": []}}
        self.assertEqual(server.write("PATCH", "/channels/7/messages/8", body)["id"], "8")
        self.assertEqual(sleeps, [2.1, migrate.WRITE_DELAY])
        server.write("DELETE", "/channels/7/pins/8")
        self.assertEqual([r.get_method() for r in requests[-2:]], ["PATCH", "DELETE"])
        for req in requests:
            self.assertEqual(req.get_header("X-audit-log-reason"), migrate.AUDIT_REASON)

    def test_delete_only_unpins_or_takes_a_role_off_a_member(self):
        api = migrate.client("TOKEN", urlopen=lambda *a, **k: self.fail("no request may be sent"))
        for path in ("/channels/7", "/channels/7/messages/8", f"/guilds/{GID}/roles/9", f"/guilds/{GID}/members/5",
                     "/channels/7/pins/8/x", f"/guilds/{GID}/members/5/roles/9?x=1", "/channels/7/permissions/9"):
            with self.assertRaises(dc.ConfigError, msg=path):
                api.request("DELETE", path)
        self.assertTrue(api.allowed("DELETE", "/channels/7/pins/8"))
        self.assertTrue(api.allowed("DELETE", f"/guilds/{GID}/members/5/roles/9"))
        self.assertFalse(dc.Discord("TOKEN", urlopen=lambda *a, **k: None).allowed("DELETE", "/channels/7/pins/8"))


if __name__ == "__main__":
    unittest.main()
