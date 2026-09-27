import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import discord_config as dc  # noqa: E402

GID = "1"
ROLES = {"Member": "10", "Newbie": "11"}
PROFILES = {"p": {"@everyone": {"deny": ["VIEW_CHANNEL"]}, "Member": {"allow": ["VIEW_CHANNEL", "SEND_MESSAGES"]}}}
VIEW, SEND = dc.PERMISSIONS["VIEW_CHANNEL"], dc.PERMISSIONS["SEND_MESSAGES"]


def channel(cid, name, overwrites, parent=None):
    return {"id": cid, "name": name, "type": 0, "parent_id": parent, "permission_overwrites": [
        {"id": rid, "type": t, "allow": str(a), "deny": str(d)} for rid, t, a, d in overwrites]}


class Permissions(unittest.TestCase):
    def test_round_trip(self):
        self.assertEqual(dc.names(dc.bits(["VIEW_CHANNEL", "PIN_MESSAGES"])), ["VIEW_CHANNEL", "PIN_MESSAGES"])

    def test_known_bits(self):
        self.assertEqual(VIEW, 1 << 10)
        self.assertEqual(dc.PERMISSIONS["USE_APPLICATION_COMMANDS"], 1 << 31)
        self.assertEqual(dc.PERMISSIONS["BYPASS_SLOWMODE"], 1 << 52)

    def test_unknown_permission_rejected(self):
        with self.assertRaises(dc.ConfigError):
            dc.bits(["VIEW_CHANNELS"])

    def test_allow_and_deny_conflict_rejected(self):
        with self.assertRaises(dc.ConfigError):
            dc.expand_overwrites({"Member": {"allow": ["VIEW_CHANNEL"], "deny": ["VIEW_CHANNEL"]}}, {}, ROLES, GID)

    def test_unknown_role_rejected(self):
        with self.assertRaises(dc.ConfigError):
            dc.expand_overwrites({"Ghost": {"allow": ["VIEW_CHANNEL"]}}, {}, ROLES, GID)


class Planning(unittest.TestCase):
    desired = {"guild_id": GID, "profiles": PROFILES, "categories": [
        {"id": "100", "name": "Cat", "access": "p", "channels": [{"id": "101", "name": "a"}]}]}

    def test_channels_inherit_category_access(self):
        want = dc.desired_channels(self.desired, ROLES)
        self.assertEqual(want["101"]["overwrites"], {GID: (0, VIEW), "10": (VIEW | SEND, 0)})

    def test_matching_server_has_no_changes(self):
        want = dc.desired_channels(self.desired, ROLES)
        ows = [(GID, 0, 0, VIEW), ("10", 0, VIEW | SEND, 0)]
        live = [channel("100", "Cat", ows), channel("101", "a", ows, "100"), channel("102", "other", [])]
        changes, unmanaged = dc.plan(want, live, {})
        self.assertEqual(changes, [])
        self.assertEqual([c["name"] for c in unmanaged], ["other"])

    def test_diff_and_patch_keep_member_overwrites(self):
        want = dc.desired_channels(self.desired, ROLES)
        live = [channel("100", "Cat", [(GID, 0, 0, VIEW), ("10", 0, VIEW | SEND, 0)]),
                channel("101", "a", [("10", 0, VIEW, SEND), ("11", 0, 0, VIEW), ("999", 1, VIEW, 0)], "100")]
        changes, _ = dc.plan(want, live, {"10": "Member", "11": "Newbie", GID: "@everyone"})
        self.assertEqual(len(changes), 1)
        ow = changes[0]["diff"]["overwrites"]
        self.assertEqual(ow["Member"]["allow+"], ["SEND_MESSAGES"])
        self.assertEqual(ow["Member"]["deny-"], ["SEND_MESSAGES"])
        self.assertEqual(ow["Newbie"]["deny-"], ["VIEW_CHANNEL"])
        body = dc.patch_body(changes[0], live[1])
        self.assertIn({"id": "999", "type": 1, "allow": str(VIEW), "deny": "0"}, body["permission_overwrites"])
        self.assertEqual(len(body["permission_overwrites"]), 3)

    def test_missing_channel_is_an_error(self):
        want = dc.desired_channels(self.desired, ROLES)
        with self.assertRaises(dc.ConfigError):
            dc.plan(want, [channel("100", "Cat", [])], {})


class ServerJson(unittest.TestCase):
    def test_server_json_is_valid(self):
        desired = dc.load_desired(ROOT / "server.json")
        roles = {"Member": "10", "Newbie": "11", "developer": "12"}
        want = dc.desired_channels(desired, roles)
        self.assertTrue(want)
        member = dc.expand_overwrites("community", desired["profiles"], roles, desired["guild_id"])["10"]
        self.assertTrue(member[0] & dc.PERMISSIONS["USE_APPLICATION_COMMANDS"])


if __name__ == "__main__":
    unittest.main()
