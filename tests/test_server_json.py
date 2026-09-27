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
BOT_USER = "1553748824470851644"
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
REGIONS = [("North America", "\U0001F5FD"), ("Europe", "\U0001F1EA\U0001F1FA"), ("Asia", "\U0001F43C"),
           ("South America", "\U0001F1E7\U0001F1F7"), ("Oceania", "\U0001F998"), ("Africa", "\U0001F334")]


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
        self.assertEqual(sorted(self.plan_["unmanaged"]["channels"]), ["web-support", "web-support-admin"])
        self.assertEqual(self.plan_["unmanaged"]["onboarding prompts"], [])

    def test_plan_never_touches_the_storefront_channels(self):
        for phase, ops in self.plan_["ops"].items():
            for op in ops:
                self.assertFalse(any(cid in json.dumps(op["body"]) for cid in PROTECTED if phase != "positions"),
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
            if c["id"] in PROTECTED:
                continue
            self.assertEqual({o["id"] for o in c["permission_overwrites"] if o["type"] == 0} & gating, set(), c["name"])
        for profile in DESIRED["profiles"].values():
            self.assertEqual(set(profile) & {"Newbie", "Member"}, set())

    def test_member_overwrites_survive(self):
        fake = self.applied()
        gen = fake.chan("1494779609131258048")
        self.assertIn(ow("777001", P["SEND_MESSAGES"], 0, 1), gen["permission_overwrites"])

    def test_old_channels_are_archived_read_only(self):
        fake = self.applied()
        archive = fake.by_name("Archive")
        everyone = GID
        for ref in DESIRED["archive"]["channels"]:
            ch = fake.chan(ref)
            self.assertEqual(ch["parent_id"], archive["id"], ch["name"])
            ows = {o["id"]: (int(o["allow"]), int(o["deny"])) for o in ch["permission_overwrites"] if o["type"] == 0}
            allow, deny = ows[everyone]
            self.assertTrue(allow & P["VIEW_CHANNEL"] and allow & P["READ_MESSAGE_HISTORY"], ch["name"])
            self.assertTrue(deny & P["SEND_MESSAGES"] and deny & P["SEND_MESSAGES_IN_THREADS"], ch["name"])
        archived = {fake.chan(r)["name"] for r in DESIRED["archive"]["channels"]}
        hardware_software = {name for _, name, _, parent in CHANNELS
                             if parent in ("1550880981592973433", "1550881887050928248")}
        self.assertLessEqual((hardware_software - {"chatfpv"}) | {"roles", "proposals", "builds", "support"}, archived)
        self.assertEqual(len(DESIRED["archive"]["channels"]), 19)
        self.assertNotIn(CHATFPV, DESIRED["archive"]["channels"])

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

    def test_development_forums_match_the_bot_mapping(self):
        fake = self.applied()
        dev = fake.by_name("Development")
        forums = [c for c in sorted(fake.channels, key=lambda c: c["position"])
                  if c["parent_id"] == dev["id"] and c["type"] == 15 and c["name"] != "alpha-testing"]
        self.assertEqual([c["name"] for c in forums], REPOS["forums"])
        lifecycle = set(REPOS["lifecycleTags"].values())
        for forum in forums:
            tags = {t["name"] for t in forum["available_tags"]}
            products = {r["tag"] for r in REPOS["repos"].values() if r["forum"] == forum["name"]}
            self.assertLessEqual(products | lifecycle | {"schematic", "layout", "bom", "firmware", "question", "bug"},
                                 tags, forum["name"])
            self.assertLessEqual(len(tags), dc.MAX_TAGS)
            self.assertTrue(forum["flags"] & dc.REQUIRE_TAG, forum["name"])

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
        self.assertLessEqual(set(REPOS["forums"]) | {"proposals", "alpha-testing"}, granted)
        self.assertTrue(all(o["role_ids"] for o in follow["options"] if by_id[o["channel_ids"][0]]["name"]
                            in REPOS["forums"]))

    def test_automod_updates_the_existing_mention_rule(self):
        fake = self.applied()
        mention = [r for r in fake.automod if r["trigger_type"] == 5]
        self.assertEqual([(r["id"], r["name"]) for r in mention], [("8500", "Block Mention Spam")])
        self.assertEqual(mention[0]["trigger_metadata"]["mention_total_limit"], 5)
        for trigger, cap in dc.AUTOMOD_CAPS.items():
            self.assertLessEqual(len([r for r in fake.automod if r["trigger_type"] == trigger]), cap)

    def test_staff_and_linked_roles_are_never_self_assignable(self):
        self.assertLessEqual({"developer", "beta tester", "reviewer", "Support", "Maintainer", "Contributor",
                              "Verified Owner", "Verified Builder"}, set(DESIRED["guard"]["unassignable_roles"]))

    def test_open_profile_allows_slash_commands_and_blocks_everyone_pings(self):
        planner = dc.Planner(DESIRED, copy.deepcopy(self.live))
        allow, deny = planner.expand("open", "x")[GID]
        self.assertTrue(allow & P["USE_APPLICATION_COMMANDS"])
        self.assertTrue(deny & P["MENTION_EVERYONE"])


if __name__ == "__main__":
    unittest.main()
