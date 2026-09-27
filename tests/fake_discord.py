"""In-memory stand-in for the parts of the Discord REST API that discord_config.py uses.

It keeps state, answers the same routes and records every call, so tests can run
plan -> apply -> plan without the network.
"""

import copy
import itertools
import re

import discord_config as dc

GID = "1"
BOT_USER = "500"
P = dc.PERMISSIONS


def ow(rid, allow=0, deny=0, kind=0):
    return {"id": rid, "type": kind, "allow": str(allow), "deny": str(deny)}


def channel(cid, name, ctype=0, parent=None, position=0, overwrites=(), **extra):
    ch = {"id": cid, "name": name, "type": ctype, "parent_id": parent, "position": position,
          "permission_overwrites": list(overwrites), "topic": None, "rate_limit_per_user": 0, "flags": 0}
    if ctype in (15, 16):
        ch.update({"available_tags": [], "default_reaction_emoji": None, "default_sort_order": None,
                   "default_forum_layout": 0, "default_thread_rate_limit_per_user": 0})
    if ctype in (2, 13):
        ch.update({"bitrate": 64000, "user_limit": 0})
    ch.update(extra)
    return ch


def role(rid, name, position, permissions=0, color=0, managed=False, tags=None, hoist=False):
    return {"id": rid, "name": name, "position": position, "permissions": str(permissions), "color": color,
            "colors": {"primary_color": color, "secondary_color": None, "tertiary_color": None},
            "hoist": hoist, "mentionable": False, "managed": managed, "tags": tags}


MEMBER_VIEW = P["VIEW_CHANNEL"] | P["READ_MESSAGE_HISTORY"]


def base_state():
    """A small server shaped like the live one: Newbie denied, Member unlocks, bot on top."""
    return {
        "guild_id": GID,
        "bot_user_id": BOT_USER,
        "guild": {"id": GID, "name": "Test", "description": "old", "features": ["COMMUNITY", "NEWS"],
                  "rules_channel_id": "22", "public_updates_channel_id": "23",
                  "system_channel_id": "21", "safety_alerts_channel_id": "21"},
        "roles": [
            role(GID, "@everyone", 0, P["VIEW_CHANNEL"] | P["SEND_MESSAGES"]),
            role("99", "OpenDrone Dev", 9, dc.ADMIN, managed=True, tags={"bot_id": BOT_USER}),
            role("2", "admin", 8, dc.ADMIN, color=0xF1C40F, hoist=True),
            role("12", "developer", 7),
            role("13", "beta tester", 6),
            role("98", "Integration", 5, managed=True, tags={"bot_id": "777"}),
            role("10", "Member", 4, P["VIEW_CHANNEL"] | P["SEND_MESSAGES"]),
            role("11", "Newbie", 3),
            role("14", "FPV", 2),
            role("15", "Europe", 1),
        ],
        "emojis": [{"id": "700", "name": "fpv"}, {"id": "701", "name": "quad"}],
        "channels": [
            channel("20", "Welcome", 4, position=0, overwrites=[ow("10", MEMBER_VIEW), ow("11", P["VIEW_CHANNEL"])]),
            channel("21", "welcome", 0, "20", 0, [ow("10", MEMBER_VIEW), ow("11", P["VIEW_CHANNEL"])]),
            channel("22", "rules", 0, "20", 1, [ow("10", MEMBER_VIEW), ow("11", P["VIEW_CHANNEL"])]),
            channel("23", "announcements", 0, "20", 2, [ow("10", MEMBER_VIEW)]),
            channel("24", "roles", 0, "20", 3, [ow("10", MEMBER_VIEW)]),
            channel("100", "Chats", 4, position=1),
            channel("101", "gen-chat", 0, "100", 4, [ow("999", P["SEND_MESSAGES"], kind=1)]),
            channel("102", "builds", 0, "100", 5),
            channel("200", "Help", 4, position=2),
            channel("201", "support", 0, "200", 6),
            channel("202", "web-support", 15, "200", 7,
                    available_tags=[{"id": "2020", "name": "order", "moderated": False, "emoji_id": None, "emoji_name": None}]),
            channel("300", "Voice", 4, position=3),
            channel("301", "General", 2, "300", 0),
        ],
        "onboarding": {
            "guild_id": GID, "enabled": True, "mode": 0, "default_channel_ids": ["21", "22", "24"],
            "prompts": [{
                "id": "4000", "title": "Where are you from?", "type": 0, "single_select": True,
                "required": True, "in_onboarding": True,
                "options": [{"id": "4001", "title": "Europe", "description": "",
                             "emoji": {"id": None, "name": "\U0001F1EA\U0001F1FA", "animated": False},
                             "role_ids": ["15", "10"], "channel_ids": []}],
            }, {
                "id": "4100", "title": "Legacy prompt", "type": 0, "single_select": False,
                "required": False, "in_onboarding": False,
                "options": [{"id": "4101", "title": "x", "description": "",
                             "emoji": None, "role_ids": [], "channel_ids": []}],
            }],
        },
        "welcome_screen": None,
        "automod": [{
            "id": "5000", "guild_id": GID, "name": "Block Mention Spam", "event_type": 1, "trigger_type": 5,
            "trigger_metadata": {"mention_total_limit": 20, "mention_raid_protection_enabled": True},
            "actions": [{"type": 1, "metadata": {}}], "enabled": True, "exempt_roles": [], "exempt_channels": [],
        }],
    }


class FakeDiscord:
    def __init__(self, state=None):
        s = copy.deepcopy(state or base_state())
        self.gid = s["guild_id"]
        self.bot_user_id = s["bot_user_id"]
        self.guild, self.roles, self.emojis = s["guild"], s["roles"], s["emojis"]
        self.channels, self.onboarding = s["channels"], s["onboarding"]
        self.welcome, self.automod = s["welcome_screen"], s["automod"]
        self.calls = []
        self.ids = itertools.count(9000)

    # -- helpers --

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]

    def new_id(self):
        """The next free id: a state from an earlier fake already holds ids from the same counter."""
        used = {x["id"] for x in self.roles + self.channels + self.automod}
        used |= {t["id"] for c in self.channels for t in c.get("available_tags") or []}
        used |= {x["id"] for p in self.onboarding["prompts"] for x in [p, *p["options"]]}
        while True:
            value = str(next(self.ids))
            if value not in used:
                return value

    def chan(self, cid):
        for c in self.channels:
            if c["id"] == cid:
                return c
        raise dc.HTTPError(f"unknown channel {cid}", 404)

    def by_name(self, name):
        hits = [c for c in self.channels if c["name"] == name]
        assert len(hits) == 1, (name, hits)
        return hits[0]

    def role_by_name(self, name):
        return next(r for r in self.roles if r["name"] == name)

    @staticmethod
    def bad(msg):
        raise dc.HTTPError(f"HTTP 400 {msg}", 400)

    def apply_channel_fields(self, ch, body):
        for key, value in body.items():
            if key == "type":
                if not ({ch["type"], value} <= {0, 5}):
                    self.bad("cannot convert channel type")
                ch["type"] = value
            elif key == "available_tags":
                ch[key] = [{"id": t.get("id") or self.new_id(), "name": t["name"], "moderated": bool(t.get("moderated")),
                            "emoji_id": t.get("emoji_id"), "emoji_name": t.get("emoji_name")} for t in value]
            elif key == "permission_overwrites":
                ch[key] = [ow(o["id"], int(o["allow"]), int(o["deny"]), o["type"]) for o in value]
            else:
                ch[key] = copy.deepcopy(value)

    # -- API --

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method not in ("GET", "POST", "PATCH", "PUT"):
            raise AssertionError(f"{method} must never be sent")
        g = f"/guilds/{self.gid}"
        routes = [
            ("GET", "/users/@me", lambda m: {"id": self.bot_user_id}),
            ("GET", g, lambda m: copy.deepcopy(self.guild)),
            ("PATCH", g, self.patch_guild),
            ("GET", g + "/channels", lambda m: copy.deepcopy(self.channels)),
            ("POST", g + "/channels", self.post_channel),
            ("PATCH", g + "/channels", self.patch_positions),
            ("PATCH", r"/channels/(\d+)", self.patch_channel),
            ("GET", g + "/roles", lambda m: copy.deepcopy(self.roles)),
            ("POST", g + "/roles", self.post_role),
            ("PATCH", g + r"/roles/(\d+)", self.patch_role),
            ("GET", g + "/emojis", lambda m: copy.deepcopy(self.emojis)),
            ("GET", g + "/onboarding", lambda m: copy.deepcopy(self.onboarding)),
            ("PUT", g + "/onboarding", self.put_onboarding),
            ("GET", g + "/welcome-screen", self.get_welcome),
            ("PATCH", g + "/welcome-screen", self.patch_welcome),
            ("GET", g + "/auto-moderation/rules", lambda m: copy.deepcopy(self.automod)),
            ("POST", g + "/auto-moderation/rules", self.post_automod),
            ("PATCH", g + r"/auto-moderation/rules/(\d+)", self.patch_automod),
        ]
        self.body = copy.deepcopy(body)
        for verb, pattern, handler in routes:
            m = re.fullmatch(pattern, path)
            if verb == method and m:
                return handler(m)
        raise AssertionError(f"unexpected route {method} {path}")

    def patch_guild(self, m):
        for key, value in self.body.items():
            if key == "features":
                # sent only to carry the Community channel fields; it must never change features
                assert sorted(value) == sorted(self.guild["features"]), value
                continue
            assert key in ("description", "system_channel_flags", *dc.GUILD_CHANNELS.values()), key
            self.guild[key] = value
        return copy.deepcopy(self.guild)

    def post_channel(self, m):
        b = self.body
        if b.get("parent_id"):
            self.chan(b["parent_id"])
        assert "flags" not in b, "flags cannot be set on create"
        top = max([c["position"] for c in self.channels] + [0])
        ch = channel(self.new_id(), b["name"], b["type"], b.get("parent_id"), top + 1)
        self.apply_channel_fields(ch, {k: v for k, v in b.items() if k not in ("name", "type", "parent_id")})
        self.channels.append(ch)
        return copy.deepcopy(ch)

    def patch_positions(self, m):
        for item in self.body:
            self.chan(item["id"])["position"] = item["position"]

    def patch_channel(self, m):
        ch = self.chan(m.group(1))
        if "parent_id" in self.body and self.body["parent_id"] is not None:
            self.chan(self.body["parent_id"])
        self.apply_channel_fields(ch, self.body)
        return copy.deepcopy(ch)

    def post_role(self, m):
        for r in self.roles:
            if r["id"] != self.gid and r["position"] >= 1:
                r["position"] += 1
        b = self.body
        r = role(self.new_id(), b["name"], 1, int(b["permissions"]), b["colors"]["primary_color"], hoist=b["hoist"])
        r["mentionable"] = b["mentionable"]
        self.roles.append(r)
        return copy.deepcopy(r)

    def patch_role(self, m):
        r = next(r for r in self.roles if r["id"] == m.group(1))
        assert not r["managed"]
        for key, value in self.body.items():
            if key == "colors":
                r["colors"] = {"primary_color": value["primary_color"], "secondary_color": None, "tertiary_color": None}
                r["color"] = value["primary_color"]
            else:
                r[key] = value
        return copy.deepcopy(r)

    def put_onboarding(self, m):
        old_prompts = {p["id"] for p in self.onboarding["prompts"]}
        old_opts = {o["id"] for p in self.onboarding["prompts"] for o in p["options"]}
        prompts = []
        for p in self.body["prompts"]:
            opts = []
            for o in p["options"]:
                emoji = {"id": o.get("emoji_id"), "name": o.get("emoji_name"), "animated": bool(o.get("emoji_animated"))}
                opts.append({"id": o["id"] if o["id"] in old_opts else self.new_id(), "title": o["title"],
                             "description": o.get("description", ""),
                             "emoji": emoji if (emoji["id"] or emoji["name"]) else None,
                             "role_ids": list(o["role_ids"]), "channel_ids": list(o["channel_ids"])})
            prompts.append({"id": p["id"] if p["id"] in old_prompts else self.new_id(), "title": p["title"],
                            "type": p["type"], "single_select": p["single_select"], "required": p["required"],
                            "in_onboarding": p["in_onboarding"], "options": opts})
        self.onboarding = {"guild_id": self.gid, "prompts": prompts,
                           "default_channel_ids": list(self.body["default_channel_ids"]),
                           "enabled": self.body["enabled"], "mode": self.body["mode"]}
        return copy.deepcopy(self.onboarding)

    def get_welcome(self, m):
        if self.welcome is None:
            raise dc.HTTPError("HTTP 404 Unknown Guild Welcome Screen", 404)
        return copy.deepcopy(self.welcome)

    def patch_welcome(self, m):
        b = self.body
        self.welcome = {"description": b.get("description"), "welcome_channels": copy.deepcopy(b.get("welcome_channels", []))}
        features = [f for f in self.guild["features"] if f != dc.WELCOME_FEATURE]
        self.guild["features"] = features + ([dc.WELCOME_FEATURE] if b.get("enabled") else [])
        return copy.deepcopy(self.welcome)

    def post_automod(self, m):
        rule = {"id": self.new_id(), "guild_id": self.gid, "exempt_roles": [], "exempt_channels": [], **self.body}
        rule["trigger_metadata"] = {"keyword_filter": [], "regex_patterns": [], "allow_list": [],
                                    **rule.get("trigger_metadata", {})}
        self.automod.append(rule)
        return copy.deepcopy(rule)

    def patch_automod(self, m):
        rule = next(r for r in self.automod if r["id"] == m.group(1))
        if "trigger_type" in self.body:
            self.bad("trigger_type cannot change")
        rule.update(copy.deepcopy(self.body))
        return copy.deepcopy(rule)
