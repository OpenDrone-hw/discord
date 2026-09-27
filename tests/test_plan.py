import io
import json
import unittest
import urllib.error
from pathlib import Path

from helpers import GID, P, ROOT, ToolCase, dc, minimal_desired
from fake_discord import channel, ow, role

VIEW, SEND = P["VIEW_CHANNEL"], P["SEND_MESSAGES"]


class Permissions(unittest.TestCase):
    def test_round_trip(self):
        self.assertEqual(dc.names(dc.bits(["VIEW_CHANNEL", "PIN_MESSAGES"])), ["VIEW_CHANNEL", "PIN_MESSAGES"])

    def test_known_bits(self):
        self.assertEqual(VIEW, 1 << 10)
        self.assertEqual(P["USE_APPLICATION_COMMANDS"], 1 << 31)
        self.assertEqual(P["BYPASS_SLOWMODE"], 1 << 52)

    def test_unknown_permission_rejected(self):
        with self.assertRaises(dc.ConfigError):
            dc.bits(["VIEW_CHANNELS"])

    def test_effective_permissions(self):
        ows = {GID: (0, VIEW), "10": (VIEW, 0)}
        self.assertTrue(dc.effective(VIEW, 0, ows, GID, {"10"}) & VIEW)
        self.assertFalse(dc.effective(VIEW, 0, ows, GID, {"11"}) & VIEW)
        self.assertEqual(dc.effective(0, dc.ADMIN, {GID: (0, VIEW)}, GID, set()), dc.ALL_PERMISSIONS)


class Overwrites(ToolCase):
    def test_allow_and_deny_conflict_rejected(self):
        d = minimal_desired()
        d["categories"][0]["access"] = {"Member": {"allow": ["VIEW_CHANNEL"], "deny": ["VIEW_CHANNEL"]}}
        self.assertConfigError(d, "both allowed and denied")

    def test_unknown_role_rejected(self):
        d = minimal_desired()
        d["categories"][0]["access"] = {"Ghost": {"allow": ["VIEW_CHANNEL"]}}
        self.assertConfigError(d, "unknown role 'Ghost'")

    def test_channels_inherit_category_access_and_keep_member_overwrites(self):
        plan = self.plan(minimal_desired())
        ops = {op["label"].split(" (")[0]: op for op in plan["ops"]["channels"]}
        body = ops["#gen-chat"]["body"]["permission_overwrites"]
        self.assertIn(ow("999", SEND, 0, 1), body)  # member overwrite survives
        roles = {o["id"]: (int(o["allow"]), int(o["deny"])) for o in body if o["type"] == 0}
        self.assertEqual(roles, {rid: v for rid, v in dc.Planner(minimal_desired(), dc.fetch(self.fake, GID))
                                 .expand("community", "x").items()})

    def test_matching_server_has_no_changes(self):
        self.assertIdempotent(minimal_desired())

    def test_missing_id_is_an_error(self):
        d = minimal_desired()
        d["categories"][0]["channels"].append({"id": "4242", "name": "ghost"})
        self.assertConfigError(d, "4242 does not exist")

    def test_unknown_keys_rejected(self):
        d = minimal_desired()
        d["categories"][0]["channels"][0]["colour"] = "red"
        self.assertConfigError(d, "unknown keys ['colour']")
        path = Path(self.tmp.name) / "bad.json"
        path.write_text(json.dumps({**minimal_desired(), "extra": 1}), encoding="utf-8")
        with self.assertRaises(dc.ConfigError):
            dc.load_desired(path)


class Output(ToolCase):
    def test_long_permission_lists_are_counted_unless_verbose(self):
        d = minimal_desired()
        d["profiles"]["community"]["Member"]["allow"] += ["ATTACH_FILES", "EMBED_LINKS"]
        plan = self.plan(d)
        short = "\n".join(dc.render_plan(plan))
        full = "\n".join(dc.render_plan(plan, verbose=True))
        self.assertIn("same overwrite change on", short)
        self.assertIn("Member: allow+ 6 permissions", short)
        self.assertNotIn("same overwrite change on", full)
        self.assertIn("USE_APPLICATION_COMMANDS", full)
        self.assertIn("--verbose lists them", short)
        self.assertIn("admin, beta tester", full)

    def test_counts_and_unmanaged(self):
        text = "\n".join(dc.render_plan(self.plan(minimal_desired())))
        self.assertIn("3 change(s): categories 1, channels 2", text)
        self.assertIn("Unmanaged channels left alone (10)", text)

    def test_no_changes_message(self):
        self.apply(minimal_desired())
        code, out, _ = self.run_cli(minimal_desired(), "plan")
        self.assertEqual(code, 0)
        self.assertIn("No changes: the server matches server.json.", out)


class FakeResponse:
    def __init__(self, body=b"{}", headers=None):
        self.body, self.headers = body, headers or {}

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Client(unittest.TestCase):
    def client(self, responses):
        self.requests, self.sleeps = [], []
        queue = list(responses)

        def urlopen(req, context=None, timeout=None):
            self.requests.append(req)
            item = queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        return dc.Discord("TOKEN", urlopen=urlopen, sleep=self.sleeps.append)

    def test_delete_is_refused(self):
        with self.assertRaises(dc.ConfigError):
            self.client([]).request("DELETE", "/channels/1")
        self.assertEqual(self.requests, [])

    def test_audit_reason_on_every_request(self):
        api = self.client([FakeResponse(), FakeResponse(b"")])
        api.request("PATCH", "/channels/1", {"name": "x"})
        api.request("GET", "/guilds/1")
        for req in self.requests:
            self.assertEqual(req.get_header("X-audit-log-reason"), dc.AUDIT_REASON)

    def test_429_waits_retry_after_then_retries(self):
        err = urllib.error.HTTPError("u", 429, "Too Many Requests", {}, io.BytesIO(b'{"retry_after": 0.5, "global": false}'))
        api = self.client([err, FakeResponse(b'{"ok": 1}')])
        self.assertEqual(api.request("GET", "/x"), {"ok": 1})
        self.assertEqual(self.sleeps, [0.6])

    def test_empty_bucket_waits_reset_after(self):
        api = self.client([FakeResponse(b"{}", {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "1.5"})])
        api.request("GET", "/x")
        self.assertEqual(self.sleeps, [1.5])

    def test_http_error_carries_status(self):
        err = urllib.error.HTTPError("u", 404, "Not Found", {}, io.BytesIO(b'{"code": 10069}'))
        with self.assertRaises(dc.HTTPError) as ctx:
            self.client([err]).request("GET", "/x")
        self.assertEqual(ctx.exception.status, 404)


def state_from_server_json(desired):
    """A live state in which every managed channel already has the overwrites server.json asks for."""
    roles = [role(desired["guild_id"], "@everyone", 0, VIEW | SEND),
             role("99", "OpenDrone Dev", 9, dc.ADMIN, managed=True, tags={"bot_id": "500"}),
             role("2", "admin", 8, dc.ADMIN), role("12", "developer", 7), role("13", "beta tester", 6),
             role("16", "reviewer", 6), role("17", "Support", 6),
             role("10", "Member", 4, VIEW), role("11", "Newbie", 3)]
    state = {"guild_id": desired["guild_id"], "bot_user_id": "500", "guild": {"features": []}, "roles": roles,
             "emojis": [], "onboarding": None, "welcome_screen": None, "automod": [],
             "channels": [channel("21", "welcome", overwrites=[ow("10", VIEW)]),
                          channel("22", "rules", overwrites=[ow("10", VIEW)])]}
    for cid in desired["guard"]["protected_channels"]:
        state["channels"].append(channel(cid, f"protected-{cid}", 0, desired["categories"][1]["id"], 99))
    planner = dc.Planner(desired, state)
    pos = 10
    for cat in desired["categories"]:
        cat_ow = planner.expand(cat["access"], "x")
        state["channels"].append(channel(cat["id"], cat["name"], 4, position=pos,
                                         overwrites=[ow(r, a, d) for r, (a, d) in cat_ow.items()]))
        for ch in cat["channels"]:
            pos += 1
            state["channels"].append(channel(ch["id"], ch["name"], 0, cat["id"], pos,
                                             [ow(r, a, d) for r, (a, d) in cat_ow.items()]))
    return state


class ServerJson(unittest.TestCase):
    def setUp(self):
        self.desired = dc.load_desired(ROOT / "server.json")

    def test_manages_the_same_23_channels(self):
        ids = [self.desired["categories"][i]["id"] for i in range(len(self.desired["categories"]))]
        ids += [ch["id"] for cat in self.desired["categories"] for ch in cat["channels"]]
        self.assertEqual(len(ids), 23)
        self.assertEqual(len(set(ids)), 23)

    def test_valid_and_idempotent_against_a_matching_server(self):
        state = state_from_server_json(self.desired)
        plan = dc.build_plan(self.desired, state)
        self.assertEqual(plan["total"], 0, "\n".join(dc.render_plan(plan, True)))
        self.assertEqual(plan["unmanaged"]["channels"], ["protected-1495130821835624610",
                                                         "protected-1497547194159599778", "rules", "welcome"])

    def test_members_use_slash_commands(self):
        planner = dc.Planner(self.desired, state_from_server_json(self.desired))
        member = planner.expand("community", "x")["10"]
        self.assertTrue(member[0] & P["USE_APPLICATION_COMMANDS"])

    def test_staff_roles_are_never_self_assignable(self):
        self.assertEqual(set(self.desired["guard"]["unassignable_roles"]),
                         {"developer", "beta tester", "reviewer", "Support"})

    def test_storefront_support_channels_are_protected(self):
        self.assertEqual(set(self.desired["guard"]["protected_channels"]),
                         {"1497547194159599778", "1495130821835624610"})


if __name__ == "__main__":
    unittest.main()
