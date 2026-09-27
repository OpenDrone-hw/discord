"""server.json against an offline copy of the live server's shape: plan, apply to FakeDiscord, read back.

The fixture mirrors the live channel ids, names, types and parents, the role names, the custom emojis,
the one onboarding prompt and the one AutoMod rule, with the Newbie and Member overwrites the live
channels carry. No member data and no network.
"""

import copy
import json
import unittest

from helpers import ROOT, ToolCase, dc
from fake_discord import FakeDiscord, channel, ow, role

P = dc.PERMISSIONS
DESIRED = dc.load_desired(ROOT / "server.json")
GID = DESIRED["guild_id"]
BOT_USER = "1553826696673759344"
REPOS = json.loads((ROOT / "bot" / "config" / "repos.json").read_text(encoding="utf-8"))
PROTECTED = set(DESIRED["guard"]["protected_channels"])
CHATFPV = "1510002456849813595"

MEMBER_ALLOW = P["VIEW_CHANNEL"] | P["SEND_MESSAGES"] | P["READ_MESSAGE_HISTORY"]
NEWBIE_DENY = P["VIEW_CHANNEL"] | P["SEND_MESSAGES"]

# (id, name, type, parent id); list order is live position order
CATEGORIES = [
    ("1494019460850389073", "Welcome"), ("1494779018111746188", "Chats"), ("1497547320131190864", "Help"),
    ("1550880981592973433", "Hardware"), ("1550881887050928248", "Software"), ("1494019460850389074", "Voice channels"),
]
CHANNELS = [
    ("1494019460850389075", "welcome", 0, "1494019460850389073"),
    ("1494792999844974800", "rules", 0, "1494019460850389073"),
    ("1494032474626326548", "announcements", 0, "1494019460850389073"),
    ("1494780931498705057", "roles", 0, "1494019460850389073"),
    ("1494779609131258048", "gen-chat", 0, "1494779018111746188"),
    ("1494033189532860707", "proposals", 0, "1494779018111746188"),
    ("1494781139980779682", "introduce-yourself", 0, "1494779018111746188"),
    ("1494782854117326969", "builds", 0, "1494779018111746188"),
    ("1497547403140530237", "support", 0, "1497547320131190864"),
    ("1497547194159599778", "web-support-admin", 0, "1497547320131190864"),
    ("1495130821835624610", "web-support", 15, "1497547320131190864"),
    ("1494783056026796262", "fc", 0, "1550880981592973433"),
    ("1494758396577058900", "vtx", 0, "1550880981592973433"),
    ("1494758355825328158", "frame", 0, "1550880981592973433"),
    ("1538618173354414190", "aio", 0, "1550880981592973433"),
    ("1494803018770809065", "digital-vtx", 0, "1550880981592973433"),
    ("1494758377010757682", "remote-id", 0, "1550880981592973433"),
    ("1494758332903456969", "rx", 0, "1550880981592973433"),
    ("1494782966302507118", "esc", 0, "1550880981592973433"),
    ("1550883307246461033", "gps", 0, "1550880981592973433"),
    ("1550883427220197396", "motors", 0, "1550880981592973433"),
    ("1550884618322972693", "charger", 0, "1550880981592973433"),
    ("1510002456849813595", "chatfpv", 0, "1550881887050928248"),
    ("1494758297885212832", "esc-am32", 0, "1550881887050928248"),
    ("1494783023114096821", "fc-betaflight", 0, "1550881887050928248"),
    ("1494796004615131237", "opendrone-web", 0, "1550881887050928248"),
    ("1550882869839134810", "rx-expresslrs", 0, "1550881887050928248"),
    ("1494019460850389076", "General", 2, "1494019460850389074"),
    ("1494786474028044469", "Troubleshooting", 2, "1494019460850389074"),
]
ROLE_NAMES = ["admin", "developer", "beta tester", "ExpressLRS", "Betaflight", "AM32", "Europe", "North America",
              "South America", "Asia", "Oceania", "Africa", "Member", "Newbie", "Plane", "Camera", "FPV", "Tinywhoop",
              "Racing", "Freestyle", "Commercial", "Long Range", "Cinewhoop", "Toothpick", "reviewer", "Support"]
MANAGED_ROLES = ["carl-bot", "OpenDrone Support", "OpenBrain", "Server Booster"]
EMOJIS = ["quad", "fpv", "tinywhoop", "freestyle", "commercial", "longrange", "cinewhoop", "toothpick", "camera",
          "planes", "racing"]
HARDWARE, SOFTWARE = "1550880981592973433", "1550881887050928248"
BUILDS, PROPOSALS, SUPPORT_CHAT = "1494782854117326969", "1494033189532860707", "1497547403140530237"
# Channel id -> (category, name in server.json) for every channel the archive held that server.json still
# manages. The old support chat was archived too; it is retired with the empty forums.
RESTORED = {
    "1494780931498705057": ("Start", "roles"),
    PROPOSALS: ("Community", "proposals"),
    BUILDS: ("Community", "builds"),
    **{cid: ("Hardware", name) for cid, name, _t, parent in CHANNELS if parent == HARDWARE},
    **{cid: ("Software", name) for cid, name, _t, parent in CHANNELS if parent == SOFTWARE and cid != CHATFPV},
}
FIRMWARE = {"Betaflight": "Betaflight user", "AM32": "AM32 user", "ExpressLRS": "ExpressLRS user"}
REGIONS = [("North America", "\U0001F5FD"), ("Europe", "\U0001F1EA\U0001F1FA"), ("Asia", "\U0001F43C"),
           ("South America", "\U0001F1E7\U0001F1F7"), ("Oceania", "\U0001F998"), ("Africa", "\U0001F334")]
PRODUCT_CHANNELS = list(dict.fromkeys(entry["channel"] for entry in REPOS["repos"].values()))
# The empty forums the previous layout added, per category; deleted by hand after this layout is applied.
RETIRED_FORUMS = {"Community": ["builds", "proposals"],
                  "Development": ["flight-controllers", "escs", "receivers", "video", "remote-id-gps", "frames",
                                  "power", "library", "firmware", "web-and-tools"]}
# The "Follow OpenDrone development" options of the previous layout pointed at the forums.
PREVIOUS_OPTION_CHANNELS = {
    "Flight controllers": ["flight-controllers"], "ESCs": ["escs"], "Receivers": ["receivers"], "Video": ["video"],
    "Remote ID and GPS": ["remote-id-gps"], "Frames": ["frames"], "Power": ["power"], "KiCad library": ["library"],
    "Web and tools": ["web-and-tools"], "Proposals": ["proposals"], "Alpha testing": ["alpha-testing"],
}
NEW_TOPICS = ["welcome", "rules", "announcements", "gen-chat", "introduce-yourself", "charger", "builds", "proposals",
              "kicad-library"]


def current_desired():
    """The layout live before this one: every product twice, as an empty forum under Development and as the
    old text chat (#build-chat and #proposal-chat renamed), plus #support-chat and no #kicad-library."""
    d = copy.deepcopy(DESIRED)
    cats = {c["name"]: c for c in d["categories"]}
    for ch in [ch for cat in d["categories"] for ch in cat["channels"]]:
        if ch["name"] in NEW_TOPICS:
            ch.pop("topic", None)
        if ch.get("id") in (BUILDS, PROPOSALS):
            ch["name"] = {BUILDS: "build-chat", PROPOSALS: "proposal-chat"}[ch["id"]]
    for category, forums in RETIRED_FORUMS.items():
        cats[category]["channels"] += [{"name": name, "type": "forum"} for name in forums]
    cats["Support"]["channels"].insert(1, {"id": SUPPORT_CHAT, "name": "support-chat"})
    cats["Hardware"]["channels"] = [ch for ch in cats["Hardware"]["channels"] if ch["name"] != "kicad-library"]
    onboarding = d["onboarding"]
    onboarding["default_channels"] = ["welcome", "rules", "announcements", "gen-chat", "introduce-yourself",
                                      "off-topic", "flying", "help", "builds", "build-chat", "proposal-chat",
                                      "support-chat", "Hardware", "Software"]
    for prompt in onboarding["prompts"]:
        for option in prompt["options"]:
            if prompt["title"] == "Follow OpenDrone development":
                option["channels"] = PREVIOUS_OPTION_CHANNELS[option["title"]]
            elif prompt["title"] == "Firmware":
                option["channels"] = ["firmware"]
    return d


def fake_state(fake):
    return {"guild_id": fake.gid, "bot_user_id": fake.bot_user_id, "guild": fake.guild, "roles": fake.roles,
            "emojis": fake.emojis, "channels": fake.channels, "onboarding": fake.onboarding,
            "welcome_screen": fake.welcome, "automod": fake.automod}


def live_state():
    roles = [role(GID, "@everyone", 0, P["VIEW_CHANNEL"] | P["SEND_MESSAGES"] | P["READ_MESSAGE_HISTORY"]
                  | P["ADD_REACTIONS"] | P["CONNECT"] | P["SPEAK"] | P["USE_APPLICATION_COMMANDS"]),
             role("9001", "OpenDrone Dev", 60, dc.ADMIN, managed=True, tags={"bot_id": BOT_USER})]
    ids = {}
    for i, name in enumerate(ROLE_NAMES):
        rid = str(9100 + i)
        ids[name] = rid
        perms = dc.ADMIN if name == "admin" else MEMBER_ALLOW if name == "Member" else 0
        roles.append(role(rid, name, 50 - i, perms))
    for i, name in enumerate(MANAGED_ROLES):
        roles.append(role(str(9200 + i), name, 20 - i, 0, managed=True, tags={"bot_id": str(9300 + i)}))
    gated = [ow(ids["Newbie"], 0, NEWBIE_DENY), ow(ids["Member"], MEMBER_ALLOW)]
    channels = [channel(cid, name, 4, position=pos, overwrites=gated) for pos, (cid, name) in enumerate(CATEGORIES)]
    for pos, (cid, name, ctype, parent) in enumerate(CHANNELS):
        if cid in PROTECTED:
            overwrites = [ow(GID, 0, P["VIEW_CHANNEL"]), ow(ids["Support"], P["VIEW_CHANNEL"]),
                          ow("777000", P["VIEW_CHANNEL"], 0, 1)]
        else:
            overwrites = gated + [ow("777001", P["SEND_MESSAGES"], 0, 1)]
        channels.append(channel(cid, name, ctype, parent, pos, overwrites))
    onboarding = {
        "guild_id": GID, "enabled": True, "mode": 0,
        "default_channel_ids": ["1494780931498705057", "1494033189532860707", "1494792999844974800",
                                "1494019460850389073", "1494019460850389075"],
        "prompts": [{
            "id": "8000", "title": "Where are you from?", "type": 0, "single_select": True, "required": True,
            "in_onboarding": True,
            "options": [{"id": str(8001 + i), "title": name, "description": "",
                         "emoji": {"id": None, "name": emoji, "animated": False},
                         "role_ids": [ids[name], ids["Member"]], "channel_ids": []}
                        for i, (name, emoji) in enumerate(REGIONS)],
        }],
        "below_requirements": False,
    }
    return {
        "guild_id": GID, "bot_user_id": BOT_USER,
        "guild": {"id": GID, "name": "OpenDrone", "description": "unchanged", "features": ["COMMUNITY", "NEWS"],
                  "rules_channel_id": "1494792999844974800", "public_updates_channel_id": "1494032474626326548",
                  "system_channel_id": "1494019460850389075", "safety_alerts_channel_id": "1494019460850389075"},
        "roles": roles,
        "emojis": [{"id": str(9400 + i), "name": name} for i, name in enumerate(EMOJIS)],
        "channels": channels,
        "onboarding": onboarding,
        "welcome_screen": None,
        "automod": [{"id": "8500", "guild_id": GID, "name": "Block Mention Spam", "event_type": 1, "trigger_type": 5,
                     "trigger_metadata": {"mention_total_limit": 20, "mention_raid_protection_enabled": True},
                     "actions": [{"type": 1, "metadata": {}}], "enabled": True,
                     "exempt_roles": [], "exempt_channels": []}],
    }


class ServerJson(ToolCase):
    def setUp(self):
        super().setUp()
        self.live = live_state()
        self.fake = FakeDiscord(self.live)
        self.plan_ = dc.build_plan(DESIRED, copy.deepcopy(self.live))

    def applied(self):
        code, out, err = self.run_cli(DESIRED, "apply", "--yes")
        self.assertEqual(code, 0, out + err)
        self.assertIn("read-back: the server matches server.json", out)
        return self.fake

    def test_plan_is_valid_and_has_no_notes(self):
        self.assertEqual(self.plan_["notes"], [])
        # The old support chat is no longer in server.json; it is deleted by hand with the empty forums.
        self.assertEqual(sorted(self.plan_["unmanaged"]["channels"]), ["support", "web-support", "web-support-admin"])
        self.assertEqual(self.plan_["unmanaged"]["onboarding prompts"], [])

    def test_plan_never_touches_the_storefront_channels(self):
        # An AutoMod exemption names the storefront channels without changing them; nothing else may.
        for phase, ops in self.plan_["ops"].items():
            for op in ops:
                body = op["body"]
                if phase == "automod":
                    body = {k: v for k, v in body.items() if k != "exempt_channels"}
                self.assertFalse(any(cid in json.dumps(body) for cid in PROTECTED if phase != "positions"),
                                 op["label"])
                if phase == "positions":
                    self.assertFalse({i["id"] for i in op["body"]} & PROTECTED, op["label"])

    def test_apply_reads_back_and_is_idempotent(self):
        fake = self.applied()
        again = dc.build_plan(DESIRED, dc.fetch(fake, GID))
        self.assertEqual(again["total"], 0, "\n".join(dc.render_plan(again, True)))
        self.assertEqual({c[0] for c in fake.calls} - {"GET"}, {"POST", "PATCH", "PUT"})

    def test_nothing_is_deleted_and_storefront_channels_are_unchanged(self):
        fake = self.applied()
        before = {c["id"]: c for c in self.live["channels"]}
        after = {c["id"]: c for c in fake.channels}
        self.assertLessEqual(set(before), set(after))
        self.assertLessEqual({r["name"] for r in self.live["roles"]}, {r["name"] for r in fake.roles})
        for cid in PROTECTED:
            self.assertEqual(after[cid], before[cid])

    def test_gating_model_a_no_newbie_or_member_overwrites_on_managed_channels(self):
        fake = self.applied()
        gating = {r["id"] for r in fake.roles if r["name"] in ("Newbie", "Member")}
        for c in fake.channels:
            if c["id"] in PROTECTED | {SUPPORT_CHAT}:  # unmanaged
                continue
            self.assertEqual({o["id"] for o in c["permission_overwrites"] if o["type"] == 0} & gating, set(), c["name"])
        for profile in DESIRED["profiles"].values():
            self.assertEqual(set(profile) & {"Newbie", "Member"}, set())

    def test_member_overwrites_survive(self):
        fake = self.applied()
        gen = fake.chan("1494779609131258048")
        self.assertIn(ow("777001", P["SEND_MESSAGES"], 0, 1), gen["permission_overwrites"])

    def test_old_channels_are_restored_open_and_roles_is_read_only(self):
        self.assertNotIn("archive", DESIRED)
        fake = self.applied()
        cats = {c["name"]: c["id"] for c in fake.channels if c["type"] == 4}
        self.assertNotIn("Archive", cats)
        self.assertEqual(len(RESTORED), 18)
        self.assertNotIn(CHATFPV, RESTORED)
        for cid, (category, name) in RESTORED.items():
            ch = fake.chan(cid)
            self.assertEqual((ch["name"], ch["parent_id"], ch["type"]), (name, cats[category], 0), cid)
            ows = {o["id"]: (int(o["allow"]), int(o["deny"])) for o in ch["permission_overwrites"] if o["type"] == 0}
            allow, deny = ows[GID]
            if name == "roles":
                # the live Server Guide still links #roles, and Discord refuses to hide a guide channel
                self.assertTrue(allow & P["VIEW_CHANNEL"], name)
                self.assertTrue(deny & P["SEND_MESSAGES"], name)
                continue
            for perm in ("VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "SEND_MESSAGES_IN_THREADS"):
                self.assertTrue(allow & P[perm], (name, perm))
            self.assertTrue(deny & P["MENTION_EVERYONE"], name)

    def test_hardware_and_software_follow_development(self):
        fake = self.applied()
        cats = [c["name"] for c in sorted(fake.channels, key=lambda c: c["position"]) if c["type"] == 4]
        i = cats.index("Development")
        self.assertEqual(cats[i:i + 3], ["Development", "Hardware", "Software"])

    def test_firmware_user_roles_are_plain(self):
        fake = self.applied()
        roles = {r["name"]: r for r in fake.roles}
        for user in FIRMWARE.values():
            r = roles[user]
            self.assertEqual((dc.role_color(r), r["hoist"], r["mentionable"], int(r["permissions"])),
                             (0, False, False, 0), user)

    def test_chatfpv_stays_open_for_members_and_bots(self):
        # ChatFPV (OpenBrain) and the storefront support bot post in #chatfpv through their role permissions
        fake = self.applied()
        ch = fake.chan(CHATFPV)
        self.assertEqual(ch["type"], 0)
        self.assertEqual(ch["parent_id"], "1497547320131190864")
        ows = {o["id"]: (int(o["allow"]), int(o["deny"])) for o in ch["permission_overwrites"] if o["type"] == 0}
        allow, deny = ows[GID]
        for perm in ("VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "SEND_MESSAGES_IN_THREADS"):
            self.assertTrue(allow & P[perm], perm)
        self.assertEqual(sum(d & (P["VIEW_CHANNEL"] | P["SEND_MESSAGES"]) for _, d in ows.values()), 0)

    def test_announcement_channels(self):
        fake = self.applied()
        self.assertEqual(fake.chan("1494032474626326548")["type"], 5)
        self.assertEqual(fake.by_name("git-feed")["type"], 5)

    def test_one_text_channel_per_product_matches_the_bot_mapping(self):
        fake = self.applied()
        cats = {c["id"]: c["name"] for c in fake.channels if c["type"] == 4}
        self.assertNotIn("forums", REPOS)
        self.assertEqual(len(PRODUCT_CHANNELS), 14)
        for name in PRODUCT_CHANNELS:
            ch = fake.by_name(name)
            self.assertEqual(ch["type"], 0, name)
            self.assertIn(cats[ch["parent_id"]], ("Hardware", "Software"), name)
        dev = fake.by_name("Development")["id"]
        self.assertEqual(sorted(c["name"] for c in fake.channels if c["parent_id"] == dev), ["alpha-testing", "git-feed"])
        forums = sorted(ch["name"] for cat in DESIRED["categories"] for ch in cat["channels"] if ch.get("type") == "forum")
        self.assertEqual(forums, ["alpha-testing", "help"])
        self.assertEqual(fake.by_name("kicad-library")["topic"],
                         "KiCad-Library parts, footprints, datasheets and hardware-template.")

    def test_text_channels_get_one_line_topics(self):
        fake = self.applied()
        for name in NEW_TOPICS:
            topic = fake.by_name(name)["topic"]
            self.assertTrue(topic and "\n" not in topic and "\u2014" not in topic, name)

    def test_bot_channels_and_roles_exist_after_apply(self):
        fake = self.applied()
        names = {c["name"] for c in fake.channels}
        self.assertLessEqual(set(REPOS["channels"].values()), names)
        self.assertLessEqual(set(REPOS["roles"].values()), {r["name"] for r in fake.roles})

    def test_onboarding(self):
        fake = self.applied()
        ob = fake.onboarding
        self.assertEqual(ob["mode"], dc.ONBOARDING_MODES["advanced"])
        self.assertEqual(ob["prompts"][0], self.live["onboarding"]["prompts"][0])  # region prompt kept exactly
        by_id = {c["id"]: c for c in fake.channels}
        roles = {r["id"]: r for r in fake.roles}
        everyone = int(roles[GID]["permissions"])

        def perms(c):
            ows = {o["id"]: (int(o["allow"]), int(o["deny"])) for o in c["permission_overwrites"] if o["type"] == 0}
            return dc.effective(everyone, 0, ows, GID, set())

        defaults = [by_id[c] for c in ob["default_channel_ids"]]
        open_text = [c["name"] for c in defaults if c["type"] == 0 and perms(c) & P["VIEW_CHANNEL"]
                     and perms(c) & P["SEND_MESSAGES"]]
        self.assertGreaterEqual(len(defaults), 7)
        self.assertGreaterEqual(len(open_text), 5, open_text)
        dev = fake.by_name("Development")["id"]
        self.assertFalse([c["name"] for c in defaults if c["parent_id"] == dev])
        follow = next(p for p in ob["prompts"] if p["title"] == "Follow OpenDrone development")
        granted = {by_id[c]["name"] for o in follow["options"] for c in o["channel_ids"]}
        firmware = next(p for p in ob["prompts"] if p["title"] == "Firmware")
        granted |= {by_id[c]["name"] for o in firmware["options"] for c in o["channel_ids"]}
        self.assertLessEqual(set(PRODUCT_CHANNELS) | {"proposals", "alpha-testing"}, granted)
        self.assertFalse({c["type"] for o in follow["options"] for c in map(by_id.get, o["channel_ids"])
                          if c["name"] not in ("alpha-testing",)} - {0})
        ping = {r["id"] for r in fake.roles if r["name"].endswith(" dev")}
        for option in follow["options"]:
            self.assertLessEqual(set(option["role_ids"]), ping, option["title"])
            self.assertLessEqual(len(option["description"]), 100, option["title"])
            if {by_id[c]["name"] for c in option["channel_ids"]} & set(PRODUCT_CHANNELS):
                self.assertTrue(option["role_ids"], option["title"])
        names = {by_id[c]["name"] for c in ob["default_channel_ids"]}
        self.assertEqual(names, {"welcome", "rules", "announcements", "gen-chat", "introduce-yourself", "off-topic",
                                 "flying", "help", "builds", "proposals", "Hardware", "Software"})
        self.assertIn(BUILDS, ob["default_channel_ids"])
        self.assertIn(BUILDS, [c["channel_id"] for c in fake.welcome["welcome_channels"]])
        role_names = {r["id"]: r["name"] for r in fake.roles}
        given = [[role_names[r] for r in o["role_ids"]] for o in firmware["options"]]
        self.assertEqual(sorted(given), sorted([u] for u in FIRMWARE.values()))

    def test_automod_leaves_the_system_mention_rule_alone(self):
        # Discord's own "Block Mention Spam" rule answers PATCH with 404, and the cap is one
        # mention rule, so server.json does not manage it.
        self.assertNotIn("mention_spam", [r["trigger"] for r in DESIRED["automod"]])
        fake = self.applied()
        mention = [r for r in fake.automod if r["trigger_type"] == 5]
        self.assertEqual([(r["id"], r["name"]) for r in mention], [("8500", "Block Mention Spam")])
        self.assertEqual(mention[0]["trigger_metadata"]["mention_total_limit"], 20)
        for trigger, cap in dc.AUTOMOD_CAPS.items():
            self.assertLessEqual(len([r for r in fake.automod if r["trigger_type"] == trigger]), cap)

    def test_automod_never_blocks_the_bots_or_the_storefront_channels(self):
        # AutoMod rules are server-wide: the storefront support bot relays customer text word for word
        # into #web-support threads and OpenBrain quotes users in #chatfpv, so a blocked POST loses a message.
        fake = self.applied()
        roles = {r["name"]: r["id"] for r in fake.roles}
        bots = {roles["OpenDrone Support"], roles["OpenBrain"]}
        managed = {r["name"] for r in DESIRED["automod"]}
        self.assertEqual(len(managed), 3)
        for rule in [r for r in fake.automod if r["name"] in managed]:
            self.assertLessEqual(bots, set(rule["exempt_roles"]), rule["name"])
            self.assertLessEqual(PROTECTED, set(rule["exempt_channels"]), rule["name"])

    def test_staff_and_linked_roles_are_never_self_assignable(self):
        self.assertLessEqual({"developer", "beta tester", "reviewer", "Support", "Maintainer", "Contributor",
                              "Verified Owner", "Verified Builder", *FIRMWARE},
                             set(DESIRED["guard"]["unassignable_roles"]))

    def test_an_option_giving_a_firmware_team_role_is_refused(self):
        d = copy.deepcopy(DESIRED)
        firmware = next(p for p in d["onboarding"]["prompts"] if p["title"] == "Firmware")
        firmware["options"][0]["roles"] = ["Betaflight"]
        with self.assertRaises(dc.ConfigError) as ctx:
            dc.build_plan(d, copy.deepcopy(self.live))
        self.assertIn("would give role Betaflight", str(ctx.exception))

    def test_open_profile_allows_slash_commands_and_blocks_everyone_pings(self):
        planner = dc.Planner(DESIRED, copy.deepcopy(self.live))
        allow, deny = planner.expand("open", "x")[GID]
        self.assertTrue(allow & P["USE_APPLICATION_COMMANDS"])
        self.assertTrue(deny & P["MENTION_EVERYONE"])


class FromTheCurrentLayout(ToolCase):
    """The live server before this layout: every product twice, as an empty forum and as the old text chat."""

    def setUp(self):
        super().setUp()
        self.fake = FakeDiscord(live_state())
        self.apply(current_desired())
        self.before = copy.deepcopy(fake_state(self.fake))

    def plan(self, desired, fake=None):
        return dc.build_plan(desired, dc.fetch(fake or self.fake, GID))

    def forum(self, name):
        return next(c["id"] for c in self.fake.channels if c["name"] == name and c["type"] == 15)

    def test_plan_renames_back_creates_kicad_library_and_repoints_onboarding(self):
        plan = self.plan(DESIRED)
        ops = plan["ops"]
        self.assertEqual((ops["roles"], ops["categories"], ops["archive"]), ([], [], []))
        updates = {op["path"].rsplit("/", 1)[1]: op for op in ops["channels"] if op["action"] == "update"}
        renames = {cid: op["diff"]["name"] for cid, op in updates.items() if "name" in op["diff"]}
        self.assertEqual(renames, {BUILDS: ("build-chat", "builds"), PROPOSALS: ("proposal-chat", "proposals")})
        self.assertEqual(sorted(op["label"].split(" (")[0] for op in updates.values() if "topic" in op["diff"]),
                         sorted(f"#{n}" for n in NEW_TOPICS if n != "kicad-library"))
        self.assertFalse(any("parent" in op["diff"] or op.get("overwrites") for op in updates.values()))
        self.assertEqual([op["label"] for op in ops["channels"] if op["action"] == "create"], ["#kicad-library (text)"])
        [onboarding] = ops["onboarding"]
        text = "\n".join(onboarding["summary"])
        self.assertIn("default channels: +[] -['#builds (forum)', '#support-chat']", text)
        self.assertIn("option 'Proposals': channels +['#proposals (text)'] -['#proposals (forum)']", text)
        self.assertIn("option 'Flight controllers': channels +['#fc', '#aio'] -['#flight-controllers']", text)
        self.assertIn("option 'Betaflight': channels +['#fc-betaflight'] -['#firmware']", text)
        [welcome] = ops["welcome_screen"]
        self.assertIn("'#builds (forum)', '#gen-chat'] -> ['#rules', '#announcements', '#help', '#builds (text)'",
                      "\n".join(welcome["summary"]))
        retired = [f"{n} (forum)" if n in ("builds", "proposals") else n
                   for names in RETIRED_FORUMS.values() for n in names]
        self.assertEqual(plan["unmanaged"]["channels"],
                         sorted(retired + ["support-chat", "web-support", "web-support-admin"]))
        self.assertEqual(len(plan["notes"]), 2, plan["notes"])
        self.assertIn(f"#builds ({BUILDS}) is renamed to a name unmanaged channel(s) {self.forum('builds')} still carry",
                      plan["notes"][0])
        self.assertIn(f"#proposals ({PROPOSALS}) is renamed", plan["notes"][1])

    def test_twin_names_resolve_to_the_channel_server_json_lists_by_id(self):
        planner = dc.Planner(DESIRED, dc.fetch(self.fake, GID))
        planner.plan_roles()
        planner.plan_layout()
        self.assertEqual(planner.resolve_channel("builds", "x"), BUILDS)
        self.assertEqual(planner.resolve_channel("proposals", "x"), PROPOSALS)
        self.assertEqual(planner.label(BUILDS), "#builds (text)")
        self.assertEqual(planner.label(self.forum("builds")), "#builds (forum)")
        self.assertEqual(planner.label(SUPPORT_CHAT), "#support-chat")

    def test_apply_reads_back_while_the_retired_forums_still_exist_and_deletes_nothing(self):
        self.apply(DESIRED)
        again = self.plan(DESIRED)
        self.assertEqual(again["total"], 0, "\n".join(dc.render_plan(again, True)))
        self.assertLessEqual({c["id"] for c in self.before["channels"]}, {c["id"] for c in self.fake.channels})
        self.assertEqual(sorted(c["type"] for c in self.fake.channels if c["name"] == "builds"), [0, 15])
        self.assertEqual(sorted(c["type"] for c in self.fake.channels if c["name"] == "proposals"), [0, 15])
        self.assertEqual(self.fake.chan(BUILDS)["name"], "builds")
        for cid in PROTECTED | {SUPPORT_CHAT}:
            self.assertEqual(self.fake.chan(cid), next(c for c in self.before["channels"] if c["id"] == cid))
        onboarding_ids = set(self.fake.onboarding["default_channel_ids"]) | {
            c for p in self.fake.onboarding["prompts"] for o in p["options"] for c in o["channel_ids"]}
        self.assertFalse(onboarding_ids & {self.forum(n) for names in RETIRED_FORUMS.values() for n in names})
        self.assertNotIn(SUPPORT_CHAT, onboarding_ids)

    def test_once_the_retired_channels_are_deleted_only_the_storefront_channels_are_unmanaged(self):
        self.apply(DESIRED)
        retired = {self.forum(n) for names in RETIRED_FORUMS.values() for n in names} | {SUPPORT_CHAT}
        self.fake.channels = [c for c in self.fake.channels if c["id"] not in retired]
        plan = self.plan(DESIRED)
        self.assertEqual(plan["total"], 0)
        self.assertEqual((plan["unmanaged"]["channels"], plan["notes"]), (["web-support", "web-support-admin"], []))


if __name__ == "__main__":
    unittest.main()
