#!/usr/bin/env python3
"""Plan and apply the OpenDrone Discord server layout from server.json.

Only what server.json lists is managed; everything else is reported and left
alone. Nothing is ever deleted: the REST client refuses DELETE. Every apply
writes a snapshot first and reads the server back afterwards; `restore` puts
channel overwrites, onboarding and the welcome screen back from a snapshot.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://discord.com/api/v10"
ROOT = Path(__file__).resolve().parent
SNAPSHOTS = ROOT / "snapshots"
TOKEN_VAR = "OPENDRONE_DISCORD_BOT_TOKEN"
CREDENTIALS = Path.home() / ".config/incutec/credentials.env"
AUDIT_REASON = "OpenDrone-hw/discord discord_config.py"
DISCORD_EPOCH_MS = 1420070400000

# Discord permission bit positions, D/topics/permissions.
PERMISSIONS = {
    name: 1 << bit
    for bit, name in enumerate(
        """CREATE_INSTANT_INVITE KICK_MEMBERS BAN_MEMBERS ADMINISTRATOR MANAGE_CHANNELS
        MANAGE_GUILD ADD_REACTIONS VIEW_AUDIT_LOG PRIORITY_SPEAKER STREAM VIEW_CHANNEL
        SEND_MESSAGES SEND_TTS_MESSAGES MANAGE_MESSAGES EMBED_LINKS ATTACH_FILES
        READ_MESSAGE_HISTORY MENTION_EVERYONE USE_EXTERNAL_EMOJIS VIEW_GUILD_INSIGHTS
        CONNECT SPEAK MUTE_MEMBERS DEAFEN_MEMBERS MOVE_MEMBERS USE_VAD CHANGE_NICKNAME
        MANAGE_NICKNAMES MANAGE_ROLES MANAGE_WEBHOOKS MANAGE_GUILD_EXPRESSIONS
        USE_APPLICATION_COMMANDS REQUEST_TO_SPEAK MANAGE_EVENTS MANAGE_THREADS
        CREATE_PUBLIC_THREADS CREATE_PRIVATE_THREADS USE_EXTERNAL_STICKERS
        SEND_MESSAGES_IN_THREADS USE_EMBEDDED_ACTIVITIES MODERATE_MEMBERS
        VIEW_CREATOR_MONETIZATION_ANALYTICS USE_SOUNDBOARD CREATE_GUILD_EXPRESSIONS
        CREATE_EVENTS USE_EXTERNAL_SOUNDS SEND_VOICE_MESSAGES _BIT47 SET_VOICE_CHANNEL_STATUS
        SEND_POLLS USE_EXTERNAL_APPS PIN_MESSAGES BYPASS_SLOWMODE""".split()
    )
}
VIEW = PERMISSIONS["VIEW_CHANNEL"]
ADMIN = PERMISSIONS["ADMINISTRATOR"]
ALL_PERMISSIONS = sum(PERMISSIONS.values())

CHANNEL_TYPES = {"text": 0, "voice": 2, "category": 4, "announcement": 5, "stage": 13, "forum": 15, "media": 16}
TYPE_NAMES = {v: k for k, v in CHANNEL_TYPES.items()}
CONVERTIBLE = {0, 5}  # text <-> announcement via PATCH type (Community servers)
VOICE_LIKE = {2, 13}
TOPIC_TYPES = {0: 1024, 5: 1024, 15: 4096, 16: 4096}  # type -> max topic length
SLOWMODE_TYPES = {0, 2, 13, 15, 16}
FORUM_TYPES = {15, 16}
NAME_NORMALISED_TYPES = {0, 5, 15, 16}  # Discord lowercases these names and turns whitespace into dashes
SEND = PERMISSIONS["SEND_MESSAGES"]
FORUM_LAYOUTS = {"unset": 0, "list": 1, "gallery": 2}
FORUM_SORT = {"activity": 0, "creation": 1}
REQUIRE_TAG = 1 << 4
MAX_TAGS = 20
PROMPT_TYPES = {"multiple_choice": 0, "dropdown": 1}
ONBOARDING_MODES = {"default": 0, "advanced": 1}
AUTOMOD_EVENTS = {"message_send": 1, "member_update": 2}
AUTOMOD_TRIGGERS = {"keyword": 1, "spam": 3, "keyword_preset": 4, "mention_spam": 5, "member_profile": 6}
AUTOMOD_CAPS = {1: 6, 3: 1, 4: 1, 5: 1, 6: 1}
AUTOMOD_PRESETS = {"profanity": 1, "sexual_content": 2, "slurs": 3}
AUTOMOD_ACTIONS = {"block": 1, "alert": 2, "timeout": 3, "block_interaction": 4}
AUTOMOD_METADATA = {"keyword_filter", "regex_patterns", "presets", "allow_list",
                    "mention_total_limit", "mention_raid_protection_enabled"}
GUILD_CHANNELS = {"rules_channel": "rules_channel_id", "public_updates_channel": "public_updates_channel_id",
                  "system_channel": "system_channel_id", "safety_alerts_channel": "safety_alerts_channel_id"}
WELCOME_FEATURE = "WELCOME_SCREEN_ENABLED"

PHASES = ("roles", "categories", "channels", "positions", "archive",
          "onboarding", "welcome_screen", "automod", "guild")

TOP_KEYS = {"guild_id", "guild", "profiles", "roles", "categories", "archive",
            "onboarding", "welcome_screen", "automod", "guard"}
CATEGORY_KEYS = {"id", "name", "access", "channels"}
CHANNEL_KEYS = {"id", "name", "type", "access", "topic", "slowmode", "bitrate", "user_limit", "forum"}
FORUM_KEYS = {"tags", "default_reaction", "layout", "sort", "require_tag", "post_slowmode"}
TAG_KEYS = {"name", "emoji", "moderated"}
ROLE_KEYS = {"name", "color", "hoist", "mentionable", "permissions"}
ARCHIVE_KEYS = {"id", "category", "access", "channels"}
ONBOARDING_KEYS = {"enabled", "mode", "default_channels", "prompts"}
PROMPT_KEYS = {"title", "type", "single_select", "required", "in_onboarding", "options"}
OPTION_KEYS = {"title", "description", "emoji", "roles", "channels"}
WELCOME_KEYS = {"enabled", "description", "channels"}
WELCOME_CHANNEL_KEYS = {"channel", "description", "emoji"}
AUTOMOD_KEYS = {"name", "event", "trigger", "metadata", "actions", "enabled", "exempt_roles", "exempt_channels"}
ACTION_KEYS = {"type", "message", "channel", "seconds"}
GUILD_KEYS = {"description", *GUILD_CHANNELS}
DEFAULT_GUARD = {"protected_roles": ["admin"], "member_role": "Member",
                 "member_must_see": ["welcome", "rules"], "protected_channels": []}


class ConfigError(RuntimeError):
    pass


def discord_name(name: str) -> str:
    """The name Discord stores for a text, announcement, forum or media channel."""
    return re.sub(r"\s+", "-", name.strip()).lower()


class HTTPError(ConfigError):
    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def bits(names: list[str]) -> int:
    value = 0
    for name in names:
        if name not in PERMISSIONS:
            raise ConfigError(f"unknown permission {name!r}")
        value |= PERMISSIONS[name]
    return value


def names(value: int) -> list[str]:
    known = [n for n, b in PERMISSIONS.items() if value & b]
    unknown = value & ~ALL_PERMISSIONS
    return known + ([f"0x{unknown:x}"] if unknown else [])


def check_keys(obj, allowed: set, where: str, required: tuple = ()) -> None:
    if not isinstance(obj, dict):
        raise ConfigError(f"{where}: expected an object")
    extra = set(obj) - allowed
    if extra:
        raise ConfigError(f"{where}: unknown keys {sorted(extra)}")
    for key in required:
        if key not in obj:
            raise ConfigError(f"{where}: missing {key!r}")


def check_bool(value, where: str) -> bool:
    if not isinstance(value, bool):
        raise ConfigError(f"{where}: expected true or false")
    return value


def check_int(value, where: str, low: int, high: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise ConfigError(f"{where}: expected an integer from {low} to {high}")
    return value


def parse_color(value, where: str) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 0xFFFFFF:
        return value
    if isinstance(value, str) and len(value) == 7 and value.startswith("#"):
        try:
            return int(value[1:], 16)
        except ValueError:
            pass
    raise ConfigError(f"{where}: color must be '#rrggbb' or an integer")


def snowflake_factory():
    counter = itertools.count()

    def new_id() -> str:
        ms = int(time.time() * 1000) - DISCORD_EPOCH_MS
        return str((ms << 22) | (next(counter) & 0xFFF))

    return new_id


def emoji_key(obj: dict | None) -> tuple:
    """Comparable emoji identity from any Discord shape (emoji object or emoji_id/emoji_name)."""
    if not obj:
        return (None, None)
    if "emoji" in obj and isinstance(obj.get("emoji"), dict):
        obj = {"emoji_id": obj["emoji"].get("id"), "emoji_name": obj["emoji"].get("name")}
    eid = obj.get("emoji_id")
    return (str(eid), None) if eid else (None, obj.get("emoji_name") or None)


def role_color(role: dict) -> int:
    colors = role.get("colors") or {}
    return int(colors.get("primary_color", role.get("color", 0)) or 0)


def current_overwrites(channel: dict) -> dict:
    """Role overwrites only; member overwrites are never managed."""
    return {
        o["id"]: (int(o["allow"]), int(o["deny"]))
        for o in channel.get("permission_overwrites", [])
        if o["type"] == 0 and (int(o["allow"]) or int(o["deny"]))
    }


def overwrite_body(channel: dict | None, wanted: dict) -> list[dict]:
    members = [o for o in (channel or {}).get("permission_overwrites", []) if o["type"] == 1]
    return members + [{"id": rid, "type": 0, "allow": str(a), "deny": str(d)} for rid, (a, d) in wanted.items()]


def overwrite_diff(cur: dict, new: dict, role_names: dict) -> dict:
    out = {}
    for rid in sorted(set(cur) | set(new)):
        a, b = cur.get(rid, (0, 0)), new.get(rid, (0, 0))
        if a != b:
            out[role_names.get(rid, rid)] = {
                "allow+": names(b[0] & ~a[0]), "allow-": names(a[0] & ~b[0]),
                "deny+": names(b[1] & ~a[1]), "deny-": names(a[1] & ~b[1]),
            }
    return out


def effective(everyone: int, role_perms: int, overwrites: dict, gid: str, role_ids: set) -> int:
    """Discord's permission resolution for one member holding role_ids."""
    base = everyone | role_perms
    if base & ADMIN:
        return ALL_PERMISSIONS
    a, d = overwrites.get(gid, (0, 0))
    base = (base & ~d) | a
    allow = deny = 0
    for rid in role_ids:
        a, d = overwrites.get(rid, (0, 0))
        allow, deny = allow | a, deny | d
    return (base & ~deny) | allow


# --- desired state ---------------------------------------------------------


def load_desired(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    check_keys(data, TOP_KEYS, path.name, ("guild_id", "profiles", "categories"))
    check_keys(data.get("guard", {}), set(DEFAULT_GUARD), "guard")
    return data


def placeholder(kind: str, name: str) -> str:
    return f"new:{kind}:{name}"


def is_placeholder(value) -> bool:
    return isinstance(value, str) and value.startswith("new:")


class Planner:
    """Compares server.json with a fetched server state and produces write operations per phase."""

    def __init__(self, desired: dict, state: dict, new_id=None):
        self.d, self.s = desired, state
        self.gid = desired["guild_id"]
        self.new_id = new_id or snowflake_factory()
        self.live_channels = {c["id"]: c for c in state["channels"]}
        self.live_roles = {r["id"]: r for r in state["roles"]}
        seen, dupes = set(), set()
        for r in state["roles"]:
            (dupes if r["name"] in seen else seen).add(r["name"])
        if dupes:
            raise ConfigError(f"duplicate role names on the server: {sorted(dupes)}; roles are resolved by name")
        self.role_ids = {r["name"]: r["id"] for r in state["roles"] if r["id"] != self.gid}
        self.role_names = {r["id"]: r["name"] for r in state["roles"]}
        self.role_names[self.gid] = "@everyone"
        self.emojis = {e["name"]: e for e in state.get("emojis", [])}
        self.guard = {**DEFAULT_GUARD, **desired.get("guard", {})}
        for ref in self.guard["protected_channels"]:
            if not isinstance(ref, str) or not ref.isdigit():
                raise ConfigError(f"guard.protected_channels: {ref!r} is not a channel id; protection needs ids")
            if ref not in self.live_channels:
                raise ConfigError(f"guard.protected_channels: channel {ref} does not exist on the server")
        self.ops = {phase: [] for phase in PHASES}
        self.notes: list[str] = []
        self.unmanaged: dict[str, list[str]] = {}
        self.entries: list[dict] = []  # managed categories and channels, list order
        self.archived: list[dict] = []
        self.desired_role_perms: dict[str, int] = {}

    # -- helpers --

    def add(self, phase: str, op: dict) -> None:
        op["phase"] = phase
        self.ops[phase].append(op)

    def bot_role(self) -> dict | None:
        bot = self.s.get("bot_user_id")
        for r in self.s["roles"]:
            if bot and (r.get("tags") or {}).get("bot_id") == bot:
                return r
        return None

    def role_id(self, name: str, where: str) -> str:
        if name == "@everyone":
            return self.gid
        rid = self.role_ids.get(name)
        if rid is None:
            raise ConfigError(f"{where}: unknown role {name!r} (add it to \"roles\" to create it)")
        return rid

    def expand(self, spec, where: str) -> dict:
        """Profile name or {role: {allow, deny}} -> {role_id: (allow, deny)}."""
        profiles = self.d["profiles"]
        if isinstance(spec, str):
            if spec not in profiles:
                raise ConfigError(f"{where}: unknown profile {spec!r}")
            spec = profiles[spec]
        if not isinstance(spec, dict):
            raise ConfigError(f"{where}: access must be a profile name or an object")
        result = {}
        for role, rule in spec.items():
            rid = self.role_id(role, where)
            check_keys(rule, {"allow", "deny"}, f"{where}: role {role!r}")
            allow, deny = bits(rule.get("allow", [])), bits(rule.get("deny", []))
            if allow & deny:
                raise ConfigError(f"{where}: role {role!r}: {names(allow & deny)} both allowed and denied")
            result[rid] = (allow, deny)
        return result

    def parse_emoji(self, spec, where: str) -> tuple:
        """'🛠' -> (None, '🛠'); ':fpv:' -> (custom id, 'fpv'); None/'' -> (None, None)."""
        if spec is None or spec == "":
            return (None, None)
        if not isinstance(spec, str):
            raise ConfigError(f"{where}: emoji must be a string")
        if len(spec) > 2 and spec.startswith(":") and spec.endswith(":"):
            emoji = self.emojis.get(spec[1:-1])
            if emoji is None:
                raise ConfigError(f"{where}: unknown custom emoji {spec}")
            return (emoji["id"], emoji["name"])
        return (None, spec)

    def label(self, cid) -> str:
        for e in self.entries + self.archived:
            if e["id"] == cid:
                return ("" if e["type"] == 4 else "#") + e["name"]
        ch = self.live_channels.get(cid)
        if ch:
            return ("" if ch["type"] == 4 else "#") + ch["name"]
        return str(cid)

    def live_parent_name(self, ch: dict) -> str | None:
        parent = self.live_channels.get(ch.get("parent_id") or "")
        return parent["name"] if parent else None

    def resolve_channel(self, ref, where: str) -> str:
        """Channel id, 'Category/name' or a unique name -> id (a placeholder for channels still to be created)."""
        if not isinstance(ref, str) or not ref:
            raise ConfigError(f"{where}: channel reference must be a non-empty string")
        if ref.isdigit():
            if ref not in self.live_channels:
                raise ConfigError(f"{where}: channel {ref} does not exist")
            return ref
        if "/" in ref:
            cat, name = ref.split("/", 1)
            hits = [e["id"] for e in self.entries if e["name"] == name and e.get("parent_name") == cat]
            if not hits:
                hits = [c["id"] for c in self.live_channels.values()
                        if c["name"] == name and self.live_parent_name(c) == cat]
        else:
            hits = [e["id"] for e in self.entries if e["name"] == ref]
            if not hits:
                live = [c["id"] for c in self.live_channels.values() if c["name"] == ref]
                archived = {e["id"] for e in self.archived}
                hits = [h for h in live if h not in archived] or live
        hits = list(dict.fromkeys(hits))
        if len(hits) == 1:
            return hits[0]
        if not hits:
            raise ConfigError(f"{where}: no channel {ref!r}")
        raise ConfigError(f"{where}: {ref!r} is ambiguous; use 'Category/name' or the channel id")

    # -- roles --

    def plan_roles(self) -> None:
        specs = self.d.get("roles", [])
        if not isinstance(specs, list):
            raise ConfigError("roles: expected a list")
        bot = self.bot_role()
        listed = set()
        for spec in specs:
            where = f"role {spec.get('name')!r}" if isinstance(spec, dict) else "role"
            check_keys(spec, ROLE_KEYS, where, ("name",))
            name = spec["name"]
            if name in listed:
                raise ConfigError(f"{where}: listed twice")
            if name == "@everyone":
                raise ConfigError(f"{where}: @everyone is not managed")
            listed.add(name)
            want = {}
            if "color" in spec:
                want["color"] = parse_color(spec["color"], where)
            for key in ("hoist", "mentionable"):
                if key in spec:
                    want[key] = check_bool(spec[key], f"{where}.{key}")
            if "permissions" in spec:
                want["permissions"] = bits(spec["permissions"])
            rid = self.role_ids.get(name)
            if rid is None:
                rid = placeholder("role", name)
                self.role_ids[name], self.role_names[rid] = rid, name
                if "permissions" in want:
                    self.desired_role_perms[rid] = want["permissions"]
                body = {"name": name, "colors": {"primary_color": want.get("color", 0)},
                        "hoist": want.get("hoist", False), "mentionable": want.get("mentionable", False),
                        "permissions": str(want.get("permissions", 0))}
                self.add("roles", {"action": "create", "label": f"role {name}", "method": "POST",
                                   "path": f"/guilds/{self.gid}/roles", "body": body,
                                   "summary": [f"color #{body['colors']['primary_color']:06x}, hoist {body['hoist']}, "
                                               f"mentionable {body['mentionable']}, "
                                               f"{len(names(want.get('permissions', 0)))} permission(s)"]})
                continue
            live = self.live_roles[rid]
            if live.get("managed"):
                self.notes.append(f"role {name} is managed by an integration; skipped")
                continue
            if "permissions" in want:
                self.desired_role_perms[rid] = want["permissions"]
            diff, body = {}, {}
            if "color" in want and role_color(live) != want["color"]:
                diff["color"] = (f"#{role_color(live):06x}", f"#{want['color']:06x}")
                body["colors"] = {"primary_color": want["color"]}
            for key in ("hoist", "mentionable"):
                if key in want and bool(live.get(key)) != want[key]:
                    diff[key] = (bool(live.get(key)), want[key])
                    body[key] = want[key]
            perm_lines = []
            if "permissions" in want and int(live["permissions"]) != want["permissions"]:
                have = int(live["permissions"])
                body["permissions"] = str(want["permissions"])
                perm_lines = [("permissions", names(want["permissions"] & ~have), names(have & ~want["permissions"]))]
            if not body:
                continue
            if bot and live["position"] >= bot["position"]:
                raise ConfigError(f"{where}: sits at or above the bot's role, so the bot cannot edit it")
            self.add("roles", {"action": "update", "label": f"role {name}", "method": "PATCH",
                               "path": f"/guilds/{self.gid}/roles/{rid}", "body": body, "diff": diff,
                               "perm_lines": perm_lines})
        self.unmanaged["roles"] = sorted(r["name"] for r in self.s["roles"]
                                         if r["id"] != self.gid and r["name"] not in listed)

    # -- categories, channels, archive --

    def match(self, spec: dict, parent_id, want_type, where: str, matched: set, excluded: set) -> dict | None:
        def compatible(have: int) -> bool:
            if want_type is None:
                return have != 4
            if want_type == 4:
                return have == 4
            return have == want_type or (have in CONVERTIBLE and want_type in CONVERTIBLE)

        if spec.get("id"):
            live = self.live_channels.get(spec["id"])
            if live is None:
                raise ConfigError(f"{where}: channel {spec['id']} does not exist")
            if (live["type"] == 4) != (want_type == 4):
                raise ConfigError(f"{where}: {spec['id']} is {'a' if live['type'] == 4 else 'not a'} category")
            if live["id"] in matched:
                raise ConfigError(f"{where}: channel {spec['id']} listed twice")
            matched.add(live["id"])
            return live
        if is_placeholder(parent_id):
            return None
        same = [c for c in self.live_channels.values()
                if c["name"] == spec["name"] and c.get("parent_id") == parent_id
                and c["id"] not in matched and c["id"] not in excluded]
        hits = [c for c in same if compatible(c["type"])]
        if len(hits) > 1:
            raise ConfigError(f"{where}: several live channels match by name ({', '.join(c['id'] for c in hits)}); give an id")
        if hits:
            matched.add(hits[0]["id"])
            return hits[0]
        for c in same:
            self.notes.append(f"{where}: live {TYPE_NAMES.get(c['type'], c['type'])} channel {c['id']} has the same "
                              f"name but another type; it is left alone and a new channel is created")
        return None

    def channel_want(self, spec: dict, entry: dict, where: str) -> dict:
        """Validated optional channel fields -> API field values."""
        t = entry["type"]
        want = {}
        if "topic" in spec:
            if t not in TOPIC_TYPES or not isinstance(spec["topic"], str) or len(spec["topic"]) > TOPIC_TYPES[t]:
                raise ConfigError(f"{where}: topic needs a text, announcement, forum or media channel "
                                  f"and at most {TOPIC_TYPES.get(t, 0)} characters")
            want["topic"] = spec["topic"]
        if "slowmode" in spec:
            if t not in SLOWMODE_TYPES:
                raise ConfigError(f"{where}: slowmode is not available on {TYPE_NAMES[t]} channels")
            want["rate_limit_per_user"] = check_int(spec["slowmode"], f"{where}.slowmode", 0, 21600)
        for key, low, high in (("bitrate", 8000, 384000), ("user_limit", 0, 10000)):
            if key in spec:
                if t not in VOICE_LIKE:
                    raise ConfigError(f"{where}: {key} needs a voice or stage channel")
                want[key] = check_int(spec[key], f"{where}.{key}", low, high)
        if "forum" in spec:
            if t not in FORUM_TYPES:
                raise ConfigError(f"{where}: forum settings need a forum or media channel")
            want.update(self.forum_want(spec["forum"], entry.get("live"), where))
        return want

    def forum_want(self, spec: dict, live: dict | None, where: str) -> dict:
        check_keys(spec, FORUM_KEYS, f"{where}.forum")
        want = {}
        if "tags" in spec:
            live_tags = {t["name"]: t for t in (live or {}).get("available_tags") or []}
            tags, listed = [], set()
            for tag in spec["tags"]:
                tw = f"{where}.forum tag {tag.get('name')!r}" if isinstance(tag, dict) else f"{where}.forum tag"
                check_keys(tag, TAG_KEYS, tw, ("name",))
                if not isinstance(tag["name"], str) or not 1 <= len(tag["name"]) <= 20 or tag["name"] in listed:
                    raise ConfigError(f"{tw}: tag names are unique and 1 to 20 characters")
                listed.add(tag["name"])
                eid, ename = self.parse_emoji(tag.get("emoji"), tw)
                item = {"name": tag["name"], "moderated": check_bool(tag.get("moderated", False), tw),
                        "emoji_id": eid, "emoji_name": None if eid else ename}
                if tag["name"] in live_tags:
                    item["id"] = live_tags[tag["name"]]["id"]
                tags.append(item)
            kept = [t for t in (live or {}).get("available_tags") or [] if t["name"] not in listed]
            if kept:
                self.notes.append(f"{where}: forum tags not in server.json are kept: {', '.join(t['name'] for t in kept)}")
            tags += [{k: t.get(k) for k in ("id", "name", "moderated", "emoji_id", "emoji_name")} for t in kept]
            if len(tags) > MAX_TAGS:
                raise ConfigError(f"{where}: a forum holds at most {MAX_TAGS} tags ({len(tags)} including kept ones)")
            want["available_tags"] = tags
        if "default_reaction" in spec:
            eid, ename = self.parse_emoji(spec["default_reaction"], f"{where}.forum.default_reaction")
            want["default_reaction_emoji"] = {"emoji_id": eid, "emoji_name": None if eid else ename} if (eid or ename) else None
        for key, api_key, table in (("layout", "default_forum_layout", FORUM_LAYOUTS), ("sort", "default_sort_order", FORUM_SORT)):
            if key in spec:
                if spec[key] not in table:
                    raise ConfigError(f"{where}.forum.{key}: one of {sorted(table)}")
                want[api_key] = table[spec[key]]
        if "require_tag" in spec:
            want["require_tag"] = check_bool(spec["require_tag"], f"{where}.forum.require_tag")
        if "post_slowmode" in spec:
            want["default_thread_rate_limit_per_user"] = check_int(spec["post_slowmode"], f"{where}.forum.post_slowmode", 0, 21600)
        return want

    @staticmethod
    def field_differs(key: str, have: dict, value) -> bool:
        if key == "topic":
            return (have.get("topic") or "") != value
        if key in ("rate_limit_per_user", "default_thread_rate_limit_per_user"):
            return int(have.get(key) or 0) != value
        if key == "available_tags":
            def norm(tags):
                return [(t["name"], bool(t.get("moderated")), emoji_key(t)) for t in tags or []]
            return norm(have.get(key)) != norm(value)
        if key == "default_reaction_emoji":
            return emoji_key(have.get(key)) != emoji_key(value)
        if key == "require_tag":
            return bool(int(have.get("flags") or 0) & REQUIRE_TAG) != value
        return have.get(key) != value

    def display(self, key: str, value):
        if key == "available_tags":
            return [t["name"] for t in value or []]
        if key == "default_reaction_emoji":
            eid, ename = emoji_key(value)
            custom = next((e["name"] for e in self.emojis.values() if e["id"] == eid), eid)
            return f":{custom}:" if eid else ename
        if key == "topic" and isinstance(value, str) and len(value) > 60:
            return value[:57] + "..."
        return value

    def plan_entry(self, entry: dict, spec: dict, phase: str, where: str) -> None:
        want = self.channel_want(spec, entry, where)
        live = entry["live"]
        tname = TYPE_NAMES[entry["type"]]
        if live is None:
            body = {"name": entry["name"], "type": entry["type"],
                    "permission_overwrites": overwrite_body(None, entry["overwrites"])}
            if entry["type"] != 4:
                body["parent_id"] = entry["parent_id"]
            after = None
            for key, value in want.items():
                if key == "require_tag":
                    after = {"flags": REQUIRE_TAG} if value else None
                elif key == "available_tags":
                    body[key] = [{k: v for k, v in t.items() if k != "id"} for t in value]
                else:
                    body[key] = value
            where_in = f" in {entry['parent_name']}" if entry.get("parent_name") else ""
            summary = [f"{tname}{where_in}, access: {len(entry['overwrites'])} role overwrite(s)"]
            summary += [f"{k}: {self.display(k, v)!r}" for k, v in want.items()]
            self.add(phase, {"action": "create", "label": f"{self.label(entry['id'])} ({tname})", "method": "POST",
                             "path": f"/guilds/{self.gid}/channels", "body": body, "summary": summary,
                             "after_create": after})
            return
        diff, body = {}, {}
        if live["name"] != entry["name"]:
            diff["name"], body["name"] = (live["name"], entry["name"]), entry["name"]
        if entry["type_spec"] is not None and live["type"] != entry["type"]:
            if not (live["type"] in CONVERTIBLE and entry["type"] in CONVERTIBLE):
                raise ConfigError(f"{where}: cannot change {TYPE_NAMES.get(live['type'])} to {tname}; "
                                  f"archive it and create a new channel with another id")
            diff["type"], body["type"] = (TYPE_NAMES[live["type"]], tname), entry["type"]
        if entry["type"] != 4 and live.get("parent_id") != entry["parent_id"]:
            diff["parent"] = (self.label(live.get("parent_id")), entry["parent_name"])
            body["parent_id"] = entry["parent_id"]
        for key, value in want.items():
            if self.field_differs(key, live, value):
                if key == "require_tag":
                    flags = int(live.get("flags") or 0)
                    body["flags"] = (flags | REQUIRE_TAG) if value else (flags & ~REQUIRE_TAG)
                    diff[key] = (not value, value)
                else:
                    diff[key] = (self.display(key, live.get(key)), self.display(key, value))
                    body[key] = value
        ow = overwrite_diff(current_overwrites(live), entry["overwrites"], self.role_names)
        if ow:
            body["permission_overwrites"] = overwrite_body(live, entry["overwrites"])
        if body:
            self.add(phase, {"action": "update", "label": f"{self.label(entry['id'])} ({entry['id']})",
                             "method": "PATCH", "path": f"/channels/{entry['id']}", "body": body,
                             "diff": diff, "overwrites": ow})

    def plan_layout(self) -> None:
        archive = self.d.get("archive")
        if archive is not None:
            check_keys(archive, ARCHIVE_KEYS, "archive", ("category", "access", "channels"))
        refs = list(archive["channels"]) if archive else []
        excluded = {r for r in refs if isinstance(r, str) and r.isdigit()}
        protected = set(self.guard["protected_channels"])
        matched: set = set()
        specs = [(c, False) for c in self.d["categories"]]
        if archive:
            specs.append(({"id": archive.get("id"), "name": archive["category"], "access": archive["access"]}, True))
        pending = []
        for cat, is_archive in specs:
            where = f"category {cat.get('name')!r}" if isinstance(cat, dict) else "category"
            if not is_archive:
                check_keys(cat, CATEGORY_KEYS, where, ("name", "access"))
            live = self.match(cat, None, 4, where, matched, excluded)
            cid = live["id"] if live else placeholder("channel", cat["name"])
            entry = {"id": cid, "name": cat["name"], "type": 4, "type_spec": 4, "parent_id": None,
                     "parent_name": None, "live": live, "archive": is_archive,
                     "overwrites": self.expand(cat["access"], where), "children": []}
            self.entries.append(entry)
            pending.append((entry, {}, "categories", where))
            seen_names = set()
            for ch in [] if is_archive else cat.get("channels", []):
                cw = f"#{ch.get('name')} in {cat['name']}" if isinstance(ch, dict) else where
                check_keys(ch, CHANNEL_KEYS, cw, ("name",))
                if ch["name"] in seen_names and not ch.get("id"):
                    raise ConfigError(f"{cw}: listed twice")
                seen_names.add(ch["name"])
                type_spec = ch.get("type")
                if type_spec is not None and (type_spec not in CHANNEL_TYPES or type_spec == "category"):
                    raise ConfigError(f"{cw}: type must be one of {sorted(set(CHANNEL_TYPES) - {'category'})}")
                type_spec = CHANNEL_TYPES[type_spec] if type_spec else None
                clive = self.match(ch, cid, type_spec, cw, matched, excluded)
                chid = clive["id"] if clive else placeholder("channel", f"{cat['name']}/{ch['name']}")
                ctype = type_spec if type_spec is not None else (clive["type"] if clive else 0)
                if ctype in NAME_NORMALISED_TYPES and ch["name"] != discord_name(ch["name"]):
                    raise ConfigError(f"{cw}: Discord stores {TYPE_NAMES[ctype]} channel names as "
                                      f"{discord_name(ch['name'])!r}; use that name")
                centry = {"id": chid, "name": ch["name"], "type": ctype, "type_spec": type_spec,
                          "parent_id": cid, "parent_name": cat["name"], "live": clive, "archive": False,
                          "overwrites": self.expand(ch["access"], cw) if "access" in ch else entry["overwrites"]}
                entry["children"].append(centry)
                self.entries.append(centry)
                pending.append((centry, ch, "channels", cw))
        for e in self.entries:
            if e["id"] in protected:
                raise ConfigError(f"{self.label(e['id'])} is a protected channel (guard.protected_channels) and cannot be managed")

        if archive:
            arc = next(e for e in self.entries if e["archive"])
            ow = arc["overwrites"]
            managed_ids = {e["id"] for e in self.entries}
            done = set()
            for ref in refs:
                cid = self.resolve_archive(ref, arc, managed_ids)
                if cid in done:
                    raise ConfigError(f"archive: {ref!r} listed twice")
                done.add(cid)
                if cid in protected:
                    raise ConfigError(f"archive: {ref!r} is a protected channel (guard.protected_channels)")
                live = self.live_channels[cid]
                self.archived.append({"id": cid, "name": live["name"], "type": live["type"], "live": live,
                                      "parent_id": arc["id"], "overwrites": ow})
        for args in pending:
            self.plan_entry(*args)
        for a in self.archived:
            live, diff, body = a["live"], {}, {}
            if live.get("parent_id") != a["parent_id"]:
                diff["parent"] = (self.label(live.get("parent_id")), self.d["archive"]["category"])
                body["parent_id"] = a["parent_id"]
            ow = overwrite_diff(current_overwrites(live), a["overwrites"], self.role_names)
            if ow:
                body["permission_overwrites"] = overwrite_body(live, a["overwrites"])
            if body:
                self.add("archive", {"action": "update", "label": f"#{a['name']} ({a['id']})", "method": "PATCH",
                                     "path": f"/channels/{a['id']}", "body": body, "diff": diff, "overwrites": ow})
        claimed = {e["id"] for e in self.entries} | {a["id"] for a in self.archived}
        self.unmanaged["channels"] = sorted(c["name"] for c in self.live_channels.values() if c["id"] not in claimed)

    def resolve_archive(self, ref, arc: dict, managed_ids: set) -> str:
        where = f"archive: {ref!r}"
        if not isinstance(ref, str) or not ref:
            raise ConfigError("archive: channel references must be non-empty strings")
        if ref.isdigit():
            live = self.live_channels.get(ref)
            if live is None:
                raise ConfigError(f"{where}: channel does not exist")
            if ref in managed_ids:
                raise ConfigError(f"{where}: also listed under categories")
        else:
            cat, name = ref.split("/", 1) if "/" in ref else (None, ref)
            hits = [c for c in self.live_channels.values()
                    if c["name"] == name and c["type"] != 4 and c["id"] not in managed_ids
                    and (cat is None or self.live_parent_name(c) in (cat, arc["name"]))]
            if len(hits) > 1:
                in_archive = [c for c in hits if c.get("parent_id") == arc["id"]]
                hits = in_archive if len(in_archive) == 1 else hits
            if len(hits) != 1:
                raise ConfigError(f"{where}: {'ambiguous' if hits else 'no unmanaged channel with that name'}; use the channel id")
            live = hits[0]
        if live["type"] == 4:
            raise ConfigError(f"{where}: categories cannot be archived")
        return live["id"]

    # -- positions --

    def plan_positions(self) -> None:
        new_pos = itertools.count(10 ** 6)
        desired_parent = {e["id"]: e["parent_id"] for e in self.entries if e["type"] != 4}
        desired_parent.update({a["id"]: a["parent_id"] for a in self.archived})

        def slot(cid):
            live = self.live_channels.get(cid)
            return live["position"] if live else next(new_pos)

        def sort_key(item):
            cid, pos = item
            return (pos, int(cid) if cid.isdigit() else 10 ** 30)

        cats = [e for e in self.entries if e["type"] == 4]
        order = [e["id"] for e in cats if not e["archive"]] + [e["id"] for e in cats if e["archive"]]
        sibs = {c["id"]: c["position"] for c in self.live_channels.values() if c["type"] == 4}
        sibs.update({cid: slot(cid) for cid in order if cid not in sibs})
        self.reorder("category order", sibs, order, sort_key)
        for cat in cats:
            if cat["archive"]:
                continue
            for voice in (False, True):
                want = [c["id"] for c in cat["children"] if (c["type"] in VOICE_LIKE) == voice]
                if not want:
                    continue
                sib = {}
                for c in self.live_channels.values():
                    parent = desired_parent.get(c["id"], c.get("parent_id"))
                    if c["type"] != 4 and parent == cat["id"] and (c["type"] in VOICE_LIKE) == voice:
                        sib[c["id"]] = c["position"]
                sib.update({cid: slot(cid) for cid in want if cid not in sib})
                self.reorder(f"{cat['name']} {'voice' if voice else 'text'} order", sib, want, sort_key)

    def reorder(self, label: str, sibs: dict, want: list, sort_key) -> None:
        current = [cid for cid, _ in sorted(sibs.items(), key=sort_key) if cid in set(want)]
        if current == want:
            return
        slots = sorted(sibs[c] for c in want)
        for i in range(1, len(slots)):
            slots[i] = max(slots[i], slots[i - 1] + 1)
        body = [{"id": cid, "position": pos} for cid, pos in zip(want, slots) if sibs[cid] != pos]
        self.add("positions", {"action": "update", "label": label, "method": "PATCH",
                               "path": f"/guilds/{self.gid}/channels", "body": body,
                               "summary": [f"now:  {', '.join(self.label(c) for c in current)}",
                                           f"want: {', '.join(self.label(c) for c in want)}"]})

    # -- onboarding --

    def plan_onboarding(self) -> None:
        spec = self.d.get("onboarding")
        if spec is None:
            return
        check_keys(spec, ONBOARDING_KEYS, "onboarding")
        live = self.s.get("onboarding") or {"prompts": [], "default_channel_ids": [], "enabled": False, "mode": 0}
        live_prompts = {}
        for p in live["prompts"]:
            if p["title"] in live_prompts:
                raise ConfigError(f"onboarding: two live prompts are titled {p['title']!r}; prompts are matched by title")
            live_prompts[p["title"]] = p
        prompts, lines, listed = [], [], set()
        for ps in spec.get("prompts", []):
            where = f"onboarding prompt {ps.get('title')!r}" if isinstance(ps, dict) else "onboarding prompt"
            check_keys(ps, PROMPT_KEYS, where, ("title", "options"))
            if ps["title"] in listed:
                raise ConfigError(f"{where}: listed twice")
            listed.add(ps["title"])
            ptype = ps.get("type", "multiple_choice")
            if ptype not in PROMPT_TYPES:
                raise ConfigError(f"{where}: type must be one of {sorted(PROMPT_TYPES)}")
            lp = live_prompts.get(ps["title"])
            live_opts = {o["title"]: o for o in (lp or {}).get("options", [])}
            options, seen = [], set()
            for os_ in ps["options"]:
                ow = f"{where} option {os_.get('title')!r}" if isinstance(os_, dict) else where
                check_keys(os_, OPTION_KEYS, ow, ("title",))
                if os_["title"] in seen:
                    raise ConfigError(f"{ow}: listed twice")
                seen.add(os_["title"])
                eid, ename = self.parse_emoji(os_.get("emoji"), ow)
                lo = live_opts.get(os_["title"])
                options.append({
                    "id": lo["id"] if lo else self.new_id(), "title": os_["title"],
                    "description": os_.get("description", ""), "emoji_id": eid, "emoji_name": ename,
                    "emoji_animated": False,
                    "role_ids": [self.role_id(r, ow) for r in os_.get("roles", [])],
                    "channel_ids": [self.resolve_channel(c, ow) for c in os_.get("channels", [])],
                })
            kept = [o for o in (lp or {}).get("options", []) if o["title"] not in seen]
            if kept:
                self.notes.append(f"{where}: options not in server.json are kept: {', '.join(o['title'] for o in kept)}")
            options += [option_request(o) for o in kept]
            if not 1 <= len(options) <= 50:
                raise ConfigError(f"{where}: a prompt has 1 to 50 options")
            prompt = {"id": lp["id"] if lp else self.new_id(), "title": ps["title"], "type": PROMPT_TYPES[ptype],
                      "single_select": check_bool(ps.get("single_select", False), f"{where}.single_select"),
                      "required": check_bool(ps.get("required", False), f"{where}.required"),
                      "in_onboarding": check_bool(ps.get("in_onboarding", True), f"{where}.in_onboarding"),
                      "options": options}
            prompts.append(prompt)
            lines += prompt_lines(lp, prompt, self)
        kept_prompts = [p for p in live["prompts"] if p["title"] not in listed]
        self.unmanaged["onboarding prompts"] = [p["title"] for p in kept_prompts]
        prompts += [prompt_request(p) for p in kept_prompts]
        if [norm_prompt(p) for p in live["prompts"]] != [norm_prompt(p) for p in prompts] and not lines:
            lines.append(f"prompt order: {[p['title'] for p in live['prompts']]} -> {[p['title'] for p in prompts]}")
        body = {"prompts": prompts, "default_channel_ids": list(live.get("default_channel_ids", [])),
                "enabled": bool(live.get("enabled")), "mode": int(live.get("mode") or 0)}
        if "default_channels" in spec:
            want = [self.resolve_channel(c, "onboarding.default_channels") for c in spec["default_channels"]]
            if set(want) != set(body["default_channel_ids"]):
                add = [self.label(c) for c in want if c not in body["default_channel_ids"]]
                rem = [self.label(c) for c in body["default_channel_ids"] if c not in want]
                lines.append(f"default channels: +{add} -{rem}")
            body["default_channel_ids"] = want
        if "enabled" in spec and check_bool(spec["enabled"], "onboarding.enabled") != body["enabled"]:
            lines.append(f"enabled: {body['enabled']} -> {spec['enabled']}")
            body["enabled"] = spec["enabled"]
        if "mode" in spec:
            if spec["mode"] not in ONBOARDING_MODES:
                raise ConfigError(f"onboarding.mode: one of {sorted(ONBOARDING_MODES)}")
            if ONBOARDING_MODES[spec["mode"]] != body["mode"]:
                lines.append(f"mode: {body['mode']} -> {ONBOARDING_MODES[spec['mode']]} ({spec['mode']})")
                body["mode"] = ONBOARDING_MODES[spec["mode"]]
        if lines and body["enabled"]:
            self.check_onboarding_requirements(body, prompts)
        if lines:
            self.add("onboarding", {"action": "update", "label": "onboarding", "method": "PUT",
                                    "path": f"/guilds/{self.gid}/onboarding", "body": body, "summary": lines})

    def check_onboarding_requirements(self, body: dict, prompts: list[dict]) -> None:
        """Refuse a PUT that Discord rejects: at least 7 default channels, 5 of them writable by @everyone.
        Categories count as their channels; ADVANCED mode also counts channels granted by options."""
        final = {c["id"]: (c["type"], c.get("parent_id"), current_overwrites(c)) for c in self.live_channels.values()}
        for e in self.entries + self.archived:
            final[e["id"]] = (e["type"], e["parent_id"], e["overwrites"])
        refs = set(body["default_channel_ids"])
        if body["mode"] == 1:
            refs |= {c for p in prompts for o in p["options"] for c in o["channel_ids"]}
        counted = set()
        for cid in refs:
            if cid in final and final[cid][0] == 4:
                counted |= {k for k, v in final.items() if v[1] == cid and v[0] != 4}
            elif cid in final:
                counted.add(cid)
        everyone = self.desired_role_perms.get(self.gid, int(self.live_roles.get(self.gid, {}).get("permissions", 0)))
        writable = [c for c in counted
                    if effective(everyone, 0, final[c][2], self.gid, set()) & (VIEW | SEND) == VIEW | SEND]
        if len(counted) < 7 or len(writable) < 5:
            raise ConfigError(f"onboarding: Discord needs at least 7 default channels with at least 5 that @everyone "
                              f"can view and send in; this layout gives {len(counted)} channel(s), "
                              f"{len(writable)} writable by @everyone ({', '.join(sorted(self.label(c) for c in writable)) or 'none'})")

    # -- welcome screen --

    def plan_welcome(self) -> None:
        spec = self.d.get("welcome_screen")
        if spec is None:
            return
        check_keys(spec, WELCOME_KEYS, "welcome_screen")
        live = self.s.get("welcome_screen") or {}
        have = {"enabled": WELCOME_FEATURE in self.s.get("guild", {}).get("features", []),
                "description": live.get("description") or "",
                "welcome_channels": [welcome_norm(c) for c in live.get("welcome_channels") or []]}
        channels = spec.get("channels", [])
        if len(channels) > 5:
            raise ConfigError("welcome_screen: at most 5 channels")
        want_channels = []
        for c in channels:
            check_keys(c, WELCOME_CHANNEL_KEYS, "welcome_screen channel", ("channel", "description"))
            eid, ename = self.parse_emoji(c.get("emoji"), "welcome_screen channel")
            want_channels.append({"channel_id": self.resolve_channel(c["channel"], "welcome_screen"),
                                  "description": c["description"], "emoji_id": eid, "emoji_name": ename})
        want = {"enabled": check_bool(spec.get("enabled", True), "welcome_screen.enabled"),
                "description": spec.get("description", ""),
                "welcome_channels": [welcome_norm(c) for c in want_channels]}
        lines = [f"{k}: {self.display('topic', have[k])!r} -> {self.display('topic', want[k])!r}"
                 for k in ("enabled", "description") if have[k] != want[k]]
        if have["welcome_channels"] != want["welcome_channels"]:
            lines.append(f"channels: {[self.label(c[0]) for c in have['welcome_channels']]} -> "
                         f"{[self.label(c[0]) for c in want['welcome_channels']]}")
        if lines:
            body = {"enabled": want["enabled"], "description": want["description"], "welcome_channels": want_channels}
            self.add("welcome_screen", {"action": "update", "label": "welcome screen", "method": "PATCH",
                                        "path": f"/guilds/{self.gid}/welcome-screen", "body": body, "summary": lines})

    # -- automod --

    def plan_automod(self) -> None:
        specs = self.d.get("automod")
        if specs is None:
            return
        live = {}
        for r in self.s.get("automod", []):
            if r["name"] in live:
                raise ConfigError(f"automod: two live rules are named {r['name']!r}; rules are matched by name")
            live[r["name"]] = r
        counts = {}
        for r in live.values():
            counts[r["trigger_type"]] = counts.get(r["trigger_type"], 0) + 1
        listed = set()
        for spec in specs:
            where = f"automod rule {spec.get('name')!r}" if isinstance(spec, dict) else "automod rule"
            check_keys(spec, AUTOMOD_KEYS, where, ("name", "trigger", "actions"))
            if spec["name"] in listed:
                raise ConfigError(f"{where}: listed twice")
            listed.add(spec["name"])
            if spec["trigger"] not in AUTOMOD_TRIGGERS:
                raise ConfigError(f"{where}: trigger must be one of {sorted(AUTOMOD_TRIGGERS)}")
            trigger = AUTOMOD_TRIGGERS[spec["trigger"]]
            event = spec.get("event", "member_update" if trigger == 6 else "message_send")
            if event not in AUTOMOD_EVENTS:
                raise ConfigError(f"{where}: event must be one of {sorted(AUTOMOD_EVENTS)}")
            md = dict(spec.get("metadata", {}))
            check_keys(md, AUTOMOD_METADATA, f"{where}.metadata")
            if "presets" in md:
                bad = [p for p in md["presets"] if p not in AUTOMOD_PRESETS]
                if bad:
                    raise ConfigError(f"{where}: unknown presets {bad}; use {sorted(AUTOMOD_PRESETS)}")
                md["presets"] = sorted(AUTOMOD_PRESETS[p] for p in md["presets"])
            actions = [self.automod_action(a, where) for a in spec["actions"]]
            if not actions:
                raise ConfigError(f"{where}: needs at least one action")
            want = {"event_type": AUTOMOD_EVENTS[event], "trigger_metadata": md, "actions": actions,
                    "enabled": check_bool(spec.get("enabled", True), f"{where}.enabled"),
                    "exempt_roles": [self.role_id(r, where) for r in spec.get("exempt_roles", [])],
                    "exempt_channels": [self.resolve_channel(c, where) for c in spec.get("exempt_channels", [])]}
            have = live.get(spec["name"])
            if have is None:
                counts[trigger] = counts.get(trigger, 0) + 1
                if counts[trigger] > AUTOMOD_CAPS[trigger]:
                    raise ConfigError(f"{where}: Discord allows {AUTOMOD_CAPS[trigger]} {spec['trigger']} rule(s) per "
                                      f"server and that many exist; reuse the existing rule's name to update it")
                body = {"name": spec["name"], "trigger_type": trigger, **want}
                self.add("automod", {"action": "create", "label": f"automod {spec['name']}", "method": "POST",
                                     "path": f"/guilds/{self.gid}/auto-moderation/rules", "body": body,
                                     "summary": [f"{spec['trigger']}, {len(actions)} action(s), enabled {want['enabled']}"]})
                continue
            if have["trigger_type"] != trigger:
                raise ConfigError(f"{where}: Discord cannot change a rule's trigger; rename the rule")
            body, diff = {}, {}
            if have["event_type"] != want["event_type"]:
                body["event_type"] = want["event_type"]
            have_md = have.get("trigger_metadata") or {}
            if any(automod_md(k, have_md.get(k)) != automod_md(k, v) for k, v in md.items()):
                body["trigger_metadata"] = {**have_md, **md}
                diff["metadata"] = ({k: have_md.get(k) for k in md}, md)
            if [automod_action_key(a) for a in have.get("actions", [])] != [automod_action_key(a) for a in actions]:
                body["actions"] = actions
                diff["actions"] = (len(have.get("actions", [])), len(actions))
            if bool(have.get("enabled")) != want["enabled"]:
                body["enabled"] = want["enabled"]
                diff["enabled"] = (not want["enabled"], want["enabled"])
            for key in ("exempt_roles", "exempt_channels"):
                if set(have.get(key, [])) != set(want[key]):
                    body[key] = want[key]
                    diff[key] = (len(have.get(key, [])), len(want[key]))
            if body:
                self.add("automod", {"action": "update", "label": f"automod {spec['name']}", "method": "PATCH",
                                     "path": f"/guilds/{self.gid}/auto-moderation/rules/{have['id']}",
                                     "body": body, "diff": diff})
        self.unmanaged["automod rules"] = sorted(n for n in live if n not in listed)

    def automod_action(self, spec: dict, where: str) -> dict:
        check_keys(spec, ACTION_KEYS, f"{where} action", ("type",))
        kind = spec["type"]
        if kind not in AUTOMOD_ACTIONS:
            raise ConfigError(f"{where}: action type must be one of {sorted(AUTOMOD_ACTIONS)}")
        md = {}
        if kind == "block" and spec.get("message"):
            md["custom_message"] = spec["message"]
        if kind == "alert":
            if "channel" not in spec:
                raise ConfigError(f"{where}: an alert action needs a channel")
            md["channel_id"] = self.resolve_channel(spec["channel"], where)
        if kind == "timeout":
            md["duration_seconds"] = check_int(spec.get("seconds"), f"{where}.seconds", 1, 2419200)
        return {"type": AUTOMOD_ACTIONS[kind], "metadata": md}

    # -- guild --

    def plan_guild(self) -> None:
        spec = self.d.get("guild")
        if spec is None:
            return
        check_keys(spec, GUILD_KEYS, "guild")
        live = self.s.get("guild", {})
        body, diff = {}, {}
        if "description" in spec and (live.get("description") or "") != spec["description"]:
            body["description"] = spec["description"]
            diff["description"] = (self.display("topic", live.get("description") or ""), self.display("topic", spec["description"]))
        for key, api_key in GUILD_CHANNELS.items():
            if key in spec:
                cid = self.resolve_channel(spec[key], f"guild.{key}") if spec[key] else None
                if live.get(api_key) != cid:
                    body[api_key] = cid
                    diff[key] = (self.label(live.get(api_key)) if live.get(api_key) else None,
                                 self.label(cid) if cid else None)
        if body:
            self.add("guild", {"action": "update", "label": "guild settings", "method": "PATCH",
                               "path": f"/guilds/{self.gid}", "body": body, "diff": diff})

    # -- lockout guard --

    def check_guard(self) -> None:
        protected = {}
        for name in self.guard["protected_roles"]:
            if name not in self.role_ids:
                raise ConfigError(f"lockout guard: protected role {name!r} does not exist")
            protected[self.role_ids[name]] = name
        bot = self.bot_role()
        if bot:
            protected[bot["id"]] = bot["name"]
        for e in self.entries + self.archived:
            for rid, (_, deny) in e["overwrites"].items():
                if rid in protected and deny & VIEW:
                    raise ConfigError(f"lockout guard: {self.label(e['id'])} would deny VIEW_CHANNEL to {protected[rid]}")
        for rid, perms in self.desired_role_perms.items():
            live = self.live_roles.get(rid)
            if rid in protected and live and int(live["permissions"]) & ~perms & (ADMIN | VIEW):
                raise ConfigError(f"lockout guard: role {protected[rid]} would lose "
                                  f"{names(int(live['permissions']) & ~perms & (ADMIN | VIEW))}")
        member = self.guard["member_role"]
        mid = self.role_ids.get(member)
        if mid is None:
            raise ConfigError(f"lockout guard: member role {member!r} does not exist")
        everyone = int(self.live_roles.get(self.gid, {}).get("permissions", 0))
        member_perms = self.desired_role_perms.get(mid, int(self.live_roles.get(mid, {}).get("permissions", 0)))
        final = {e["id"]: e["overwrites"] for e in self.entries + self.archived}
        for ref in self.guard["member_must_see"]:
            cid = self.resolve_channel(ref, "lockout guard")
            ow = final.get(cid) if cid in final else current_overwrites(self.live_channels.get(cid, {}))
            if not effective(everyone, member_perms, ow, self.gid, {mid}) & VIEW:
                raise ConfigError(f"lockout guard: {member} would lose VIEW_CHANNEL on {self.label(cid)}")

    def build(self) -> dict:
        self.plan_roles()
        self.plan_layout()
        self.plan_positions()
        self.plan_onboarding()
        self.plan_welcome()
        self.plan_automod()
        self.plan_guild()
        self.check_guard()
        return {"ops": self.ops, "notes": self.notes, "unmanaged": self.unmanaged,
                "total": sum(len(v) for v in self.ops.values())}


# --- onboarding / welcome / automod normalisation -------------------------


def option_request(o: dict) -> dict:
    eid, ename = emoji_key(o)
    if eid and not ename:
        ename = (o.get("emoji") or {}).get("name") or o.get("emoji_name")
    return {"id": o["id"], "title": o["title"], "description": o.get("description") or "",
            "emoji_id": eid, "emoji_name": ename, "emoji_animated": bool((o.get("emoji") or {}).get("animated")),
            "role_ids": list(o.get("role_ids", [])), "channel_ids": list(o.get("channel_ids", []))}


def prompt_request(p: dict) -> dict:
    return {"id": p["id"], "title": p["title"], "type": p.get("type", 0), "single_select": bool(p.get("single_select")),
            "required": bool(p.get("required")), "in_onboarding": bool(p.get("in_onboarding", True)),
            "options": [option_request(o) for o in p.get("options", [])]}


def norm_option(o: dict) -> tuple:
    return (o["title"], o.get("description") or "", emoji_key(o),
            tuple(sorted(o.get("role_ids", []))), tuple(sorted(o.get("channel_ids", []))))


def norm_prompt(p: dict) -> tuple:
    return (p["title"], p.get("type", 0), bool(p.get("single_select")), bool(p.get("required")),
            bool(p.get("in_onboarding", True)), tuple(norm_option(o) for o in p.get("options", [])))


def prompt_lines(live: dict | None, want: dict, planner: Planner) -> list[str]:
    title = want["title"]
    if live is None:
        return [f"prompt {title!r}: new, options {[o['title'] for o in want['options']]}"]
    lines = []
    have = dict(zip(("title", "type", "single_select", "required", "in_onboarding"), norm_prompt(live)))
    for key in ("type", "single_select", "required", "in_onboarding"):
        if have[key] != want[key]:
            lines.append(f"prompt {title!r}: {key} {have[key]} -> {want[key]}")
    old = {o["title"]: o for o in live.get("options", [])}
    for o in want["options"]:
        lo = old.get(o["title"])
        if lo is None:
            lines.append(f"prompt {title!r}: new option {o['title']!r}")
            continue
        a, b = norm_option(lo), norm_option(o)
        for idx, field in ((1, "description"), (2, "emoji")):
            if a[idx] != b[idx]:
                lines.append(f"prompt {title!r} option {o['title']!r}: {field} {a[idx]!r} -> {b[idx]!r}")
        for idx, field, lab in ((3, "roles", lambda r: planner.role_names.get(r, r)), (4, "channels", planner.label)):
            if a[idx] != b[idx]:
                add = [lab(x) for x in b[idx] if x not in a[idx]]
                rem = [lab(x) for x in a[idx] if x not in b[idx]]
                lines.append(f"prompt {title!r} option {o['title']!r}: {field} +{add} -{rem}")
    if not lines and [x["title"] for x in live.get("options", [])] != [x["title"] for x in want["options"]]:
        lines.append(f"prompt {title!r}: option order changes")
    return lines


def welcome_norm(c: dict) -> tuple:
    return (c["channel_id"], c.get("description") or "", emoji_key(c))


def automod_md(key: str, value):
    if key == "presets":
        return sorted(value or [])
    if isinstance(value, list):
        return list(value)
    return value


def automod_action_key(a: dict) -> tuple:
    md = a.get("metadata") or {}
    return (a["type"], md.get("custom_message") or "", md.get("channel_id"), md.get("duration_seconds"))


# --- Discord REST ----------------------------------------------------------


def token() -> str:
    value = os.environ.get(TOKEN_VAR)
    if not value and CREDENTIALS.exists():
        for line in CREDENTIALS.read_text(encoding="utf-8").splitlines():
            if line.startswith(TOKEN_VAR + "="):
                value = line.split("=", 1)[1].strip().strip('"')
    if not value:
        raise ConfigError(f"{TOKEN_VAR} is not set (environment or {CREDENTIALS})")
    return value


def ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if not ctx.get_ca_certs() and Path("/etc/ssl/cert.pem").exists():
        ctx.load_verify_locations("/etc/ssl/cert.pem")  # python.org builds on macOS ship no CA store
    return ctx


class Discord:
    """Minimal REST client: audit-log reason on every call, 429 and bucket handling, no DELETE."""

    ALLOWED = ("GET", "POST", "PATCH", "PUT")

    def __init__(self, tok: str, urlopen=None, sleep=None):
        self.headers = {
            "Authorization": f"Bot {tok}",
            "User-Agent": "DiscordBot (https://github.com/OpenDrone-hw/discord, 2)",
            "Content-Type": "application/json",
            "X-Audit-Log-Reason": AUDIT_REASON,
        }
        self.urlopen = urlopen or urllib.request.urlopen
        self.sleep = sleep or time.sleep
        self.ctx = ssl_context() if urlopen is None else None

    def request(self, method: str, path: str, body=None):
        if method not in self.ALLOWED:
            raise ConfigError(f"{method} {path}: refused, this tool never deletes")
        data = json.dumps(body).encode() if body is not None else None
        for _ in range(6):
            req = urllib.request.Request(API + path, data=data, method=method, headers=self.headers)
            try:
                with self.urlopen(req, context=self.ctx, timeout=30) as resp:
                    raw = resp.read()
                    if resp.headers.get("X-RateLimit-Remaining") == "0":
                        self.sleep(float(resp.headers.get("X-RateLimit-Reset-After") or 1))
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode(errors="replace")
                if exc.code == 429:
                    try:
                        wait = float(json.loads(detail).get("retry_after", 1))
                    except (ValueError, AttributeError):
                        wait = float(exc.headers.get("Retry-After") or 1)
                    self.sleep(wait + 0.1)
                    continue
                raise HTTPError(f"{method} {path}: HTTP {exc.code} {detail[:300]}", exc.code) from exc
        raise ConfigError(f"{method} {path}: still rate limited after 6 attempts")


def fetch(api, gid: str) -> dict:
    """Everything the tool can change, plus what it needs to resolve names."""
    try:
        welcome = api.request("GET", f"/guilds/{gid}/welcome-screen")
    except HTTPError as exc:
        if exc.status != 404:
            raise
        welcome = None  # never configured
    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "guild_id": gid,
        "bot_user_id": api.request("GET", "/users/@me")["id"],
        "guild": api.request("GET", f"/guilds/{gid}"),
        "channels": api.request("GET", f"/guilds/{gid}/channels"),
        "roles": api.request("GET", f"/guilds/{gid}/roles"),
        "emojis": api.request("GET", f"/guilds/{gid}/emojis"),
        "onboarding": api.request("GET", f"/guilds/{gid}/onboarding"),
        "welcome_screen": welcome,
        "automod": api.request("GET", f"/guilds/{gid}/auto-moderation/rules"),
    }


def save_snapshot(state: dict, label: str) -> Path:
    SNAPSHOTS.mkdir(exist_ok=True)
    path = SNAPSHOTS / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{label}.json"
    path.write_text(json.dumps(state, indent=1), encoding="utf-8")
    return path


def execute(api, op: dict) -> None:
    if is_placeholder(op["path"].rsplit("/", 1)[-1]) or '"new:' in json.dumps(op.get("body")):
        raise ConfigError(f"{op['label']}: still refers to something that does not exist yet")
    result = api.request(op["method"], op["path"], op.get("body"))
    if op.get("after_create"):
        api.request("PATCH", f"/channels/{result['id']}", op["after_create"])


# --- output ----------------------------------------------------------------


def fmt_perms(items: list[str], verbose: bool) -> str:
    if verbose or len(items) <= 4:
        return ", ".join(items)
    return f"{len(items)} permissions"


def overwrite_lines(ow: dict, verbose: bool) -> list[str]:
    out = []
    for role, d in ow.items():
        parts = [f"{k} {fmt_perms(v, verbose)}" for k, v in d.items() if v]
        out.append(f"    {role}: " + "; ".join(parts))
    return out


def op_lines(op: dict, verbose: bool) -> list[str]:
    mark = "+" if op["action"] == "create" else "~"
    out = [f"  {mark} {op['label']}"]
    out += [f"    {line}" for line in op.get("summary", [])]
    for key, (old, new) in op.get("diff", {}).items():
        out.append(f"    {key}: {old!r} -> {new!r}")
    for key, added, removed in op.get("perm_lines", []):
        out.append(f"    {key}: +[{fmt_perms(added, verbose)}] -[{fmt_perms(removed, verbose)}]")
    out += overwrite_lines(op.get("overwrites") or {}, verbose)
    return out


def render_plan(plan: dict, verbose: bool = False) -> list[str]:
    out = []
    for phase in PHASES:
        ops = plan["ops"][phase]
        if not ops:
            continue
        out.append(f"{phase.replace('_', ' ').capitalize()} ({len(ops)})")
        groups: dict[str, list[dict]] = {}
        for op in ops:
            only_ow = op["action"] == "update" and not op.get("diff") and op.get("overwrites") and not verbose
            if only_ow and phase in ("categories", "channels", "archive"):
                groups.setdefault(json.dumps(op["overwrites"], sort_keys=True), []).append(op)
            else:
                out += op_lines(op, verbose)
        for group in groups.values():
            if len(group) == 1:
                out += op_lines(group[0], verbose)
                continue
            out.append(f"  ~ same overwrite change on {len(group)}: " + ", ".join(o["label"].split(" (")[0] for o in group))
            out += overwrite_lines(group[0]["overwrites"], verbose)
    if plan["total"]:
        counts = ", ".join(f"{p} {len(plan['ops'][p])}" for p in PHASES if plan["ops"][p])
        out.append(f"\n{plan['total']} change(s): {counts}")
    else:
        out.append("No changes: the server matches server.json.")
    um = plan["unmanaged"]
    if um.get("channels"):
        out.append(f"Unmanaged channels left alone ({len(um['channels'])}): {', '.join(um['channels'])}")
    if um.get("roles"):
        out.append(f"Unmanaged roles left alone: {len(um['roles'])}"
                   + (f" ({', '.join(um['roles'])})" if verbose else " (--verbose lists them)"))
    for key in ("automod rules", "onboarding prompts"):
        if um.get(key):
            out.append(f"Unmanaged {key} left alone: {', '.join(um[key])}")
    if plan["notes"]:
        out.append("Notes:")
        out += [f"  - {n}" for n in plan["notes"]]
    return out


# --- commands --------------------------------------------------------------


def build_plan(desired: dict, state: dict) -> dict:
    return Planner(desired, state).build()


def cmd_audit(args, api):
    desired = load_desired(args.config)
    path = save_snapshot(fetch(api, desired["guild_id"]), "audit")
    print(f"snapshot: {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}")


def cmd_plan(args, api):
    desired = load_desired(args.config)
    print("\n".join(render_plan(build_plan(desired, fetch(api, desired["guild_id"])), args.verbose)))


def cmd_apply(args, api):
    desired = load_desired(args.config)
    gid = desired["guild_id"]
    state = fetch(api, gid)
    plan = build_plan(desired, state)
    print("\n".join(render_plan(plan, args.verbose)))
    if not plan["total"]:
        return
    if not args.yes:
        print("\nDry run. Re-run with --yes to apply.")
        return
    snap = save_snapshot(state, "before-apply")
    print(f"\nsnapshot: {snap.relative_to(ROOT) if snap.is_relative_to(ROOT) else snap}")
    stale = False
    for phase in PHASES:
        if stale:
            state, stale = fetch(api, gid), False
        for op in build_plan(desired, state)["ops"][phase]:
            execute(api, op)
            stale = True
            print(f"applied {phase}: {op['label']}")
    left = build_plan(desired, fetch(api, gid))
    if left["total"]:
        print("\n".join(render_plan(left, True)))
        raise ConfigError("read-back still differs from server.json")
    print("read-back: the server matches server.json")


def restore_ops(desired: dict, snap: dict, state: dict) -> tuple[list[dict], list[str]]:
    """Operations that put managed channel overwrites and parents, onboarding and the welcome screen back."""
    gid = desired["guild_id"]
    planner = Planner(desired, state)
    planner.plan_roles()
    planner.plan_layout()
    live = planner.live_channels
    old = {c["id"]: c for c in snap["channels"]}
    ops, notes = [], []
    protected = set(planner.guard["protected_channels"])
    for e in planner.entries + planner.archived:
        cid = e["id"]
        if is_placeholder(cid) or cid in protected:
            continue
        if cid not in old:
            notes.append(f"{planner.label(cid)} did not exist in the snapshot; left alone")
            continue
        body = {}
        key = lambda ows: sorted((o["id"], o["type"], str(o["allow"]), str(o["deny"])) for o in ows)  # noqa: E731
        if key(old[cid].get("permission_overwrites", [])) != key(live[cid].get("permission_overwrites", [])):
            body["permission_overwrites"] = old[cid].get("permission_overwrites", [])
        if old[cid].get("parent_id") != live[cid].get("parent_id") and old[cid]["type"] != 4:
            body["parent_id"] = old[cid].get("parent_id")
        if body:
            ops.append({"action": "update", "label": f"{planner.label(cid)} ({cid})", "method": "PATCH",
                        "path": f"/channels/{cid}", "body": body,
                        "summary": [f"restore {', '.join(sorted(body))}"]})
    if snap.get("onboarding") is not None:
        was = snap["onboarding"]
        now = state.get("onboarding") or {}
        norm = lambda o: ([norm_prompt(p) for p in o.get("prompts", [])], sorted(o.get("default_channel_ids", [])),  # noqa: E731
                          bool(o.get("enabled")), int(o.get("mode") or 0))
        if norm(was) != norm(now):
            ops.append({"action": "update", "label": "onboarding", "method": "PUT",
                        "path": f"/guilds/{gid}/onboarding",
                        "body": {"prompts": [prompt_request(p) for p in was.get("prompts", [])],
                                 "default_channel_ids": was.get("default_channel_ids", []),
                                 "enabled": bool(was.get("enabled")), "mode": int(was.get("mode") or 0)},
                        "summary": [f"restore {len(was.get('prompts', []))} prompt(s)"]})
    if "welcome_screen" in snap:
        def ws(s):
            w = s.get("welcome_screen") or {}
            return (WELCOME_FEATURE in s.get("guild", {}).get("features", []), w.get("description") or "",
                    [welcome_norm(c) for c in w.get("welcome_channels") or []])
        if ws(snap) != ws(state):
            enabled, desc, _ = ws(snap)
            chans = [{"channel_id": c["channel_id"], "description": c.get("description") or "",
                      "emoji_id": emoji_key(c)[0], "emoji_name": c.get("emoji_name")}
                     for c in (snap.get("welcome_screen") or {}).get("welcome_channels") or []]
            ops.append({"action": "update", "label": "welcome screen", "method": "PATCH",
                        "path": f"/guilds/{gid}/welcome-screen",
                        "body": {"enabled": enabled, "description": desc or None, "welcome_channels": chans},
                        "summary": ["restore"]})
    return ops, notes


def cmd_restore(args, api):
    snap = json.loads(args.snapshot.read_text(encoding="utf-8"))
    desired = load_desired(args.config)
    gid = desired["guild_id"]
    if snap.get("guild_id") not in (None, gid):
        raise ConfigError("snapshot belongs to another server")
    state = fetch(api, gid)
    ops, notes = restore_ops(desired, snap, state)
    for op in ops:
        print("\n".join(op_lines(op, args.verbose)))
    for n in notes:
        print(f"  - {n}")
    if not ops:
        print("Nothing to restore: managed channels, onboarding and welcome screen match the snapshot.")
        return
    if not args.yes:
        print("\nDry run. Re-run with --yes to restore.")
        return
    before = save_snapshot(state, "before-restore")
    print(f"\nsnapshot: {before.relative_to(ROOT) if before.is_relative_to(ROOT) else before}")
    for op in ops:
        execute(api, op)
        print(f"restored {op['label']}")
    left, _ = restore_ops(desired, snap, fetch(api, gid))
    if left:
        raise ConfigError(f"read-back: {len(left)} item(s) still differ from the snapshot")
    print(f"read-back: restored from {args.snapshot.name}")


def main(argv=None, api=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=ROOT / "server.json")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("audit", help="save a snapshot of the live server under snapshots/")
    p = sub.add_parser("plan", help="show what apply would change")
    p.add_argument("-v", "--verbose", action="store_true", help="full permission and role lists")
    p = sub.add_parser("apply", help="dry run by default; --yes snapshots, applies and reads back")
    p.add_argument("--yes", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    p = sub.add_parser("restore", help="put overwrites, onboarding and welcome screen back from a snapshot")
    p.add_argument("snapshot", type=Path)
    p.add_argument("--yes", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    try:
        api = api or Discord(token())
        {"audit": cmd_audit, "plan": cmd_plan, "apply": cmd_apply, "restore": cmd_restore}[args.command](args, api)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
