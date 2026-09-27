"""migrate.py against an offline server: the live shape from test_server_json with the previous layout
(the Archive category) applied, then server.json applied on top.

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
from test_server_json import DESIRED, FIRMWARE, GID, RESTORED, fake_state, live_state, previous_desired

import migrate

NOW_MS = 1_790_000_000_000  # 2026-09-21
ROLLOUT_MS = migrate.parse_since(migrate.ROLLOUT_START)
DAY_MS = 86_400_000
BOT = "1553748824470851644"
FC = "1494783056026796262"
AIO = "1538618173354414190"
ESC = "1494782966302507118"
ROLES_CH = "1494780931498705057"
BETAFLIGHT_CH = "1494783023114096821"
MOTORS = "1550883427220197396"
BUILD_CHAT = "1494782854117326969"
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


PREVIOUS = applied(previous_desired(), live_state())  # the live server before this layout
APPLIED = applied(DESIRED, copy.deepcopy(PREVIOUS))  # after `discord_config.py apply --yes` of server.json


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

    def test_forums_are_managed_channels(self):
        names = [ch["name"] for cat in DESIRED["categories"] for ch in cat["channels"]]
        for cid, (_old, name, _line, forum, _unit, _role) in migrate.CHATS.items():
            if forum not in (None, migrate.CUSTOMIZE):
                self.assertEqual(names.count(forum), 1, (name, forum))

    def test_ping_roles_come_from_the_onboarding_option_for_the_forum(self):
        options = [o for p in DESIRED["onboarding"]["prompts"] for o in p["options"]]
        for cid, (_old, name, _line, forum, _unit, role) in migrate.CHATS.items():
            if role:
                self.assertTrue(any(role in o.get("roles", []) and forum in o.get("channels", [])
                                    for o in options), (name, forum, role))

    def test_no_ping_role_is_a_firmware_team_role(self):
        self.assertFalse({chat[5] for chat in migrate.CHATS.values()} & set(FIRMWARE))
        self.assertEqual(migrate.FIRMWARE_ROLES, FIRMWARE)


class Unarchive(Case):
    def seed(self):
        for cid in migrate.CHATS:
            self.fake.messages[cid] = [msg(NOW_MS - 3 * DAY_MS, "42"), notice(cid)]

    def test_dry_run_writes_nothing(self):
        self.seed()
        out = self.ok("unarchive")
        self.assertEqual(self.fake.writes(), [])
        self.assertIn("unarchive: 19 to update, 0 done, 0 without a notice, 0 blocked", out)
        self.assertIn(f"<#{self.channel_id('Development', 'flight-controllers')}>", out)
        self.assertIn("Dry run", out)

    def test_edits_and_unpins_each_notice_once(self):
        self.seed()
        self.ok("unarchive", "--yes")
        edits = [c for c in self.fake.writes() if c[0] == "PATCH"]
        unpins = [c for c in self.fake.writes() if c[0] == "DELETE"]
        self.assertEqual((len(edits), len(unpins), len(self.fake.writes())), (19, 19, 38))
        self.assertEqual(len(self.sleeps), 38)
        for _m, path, body in edits:
            self.assertEqual(body["allowed_mentions"], {"parse": []})
            self.assertNotIn("archived", body["content"])
            self.assertIn(migrate.UNARCHIVE_MARK, body["content"])
        for _m, path, body in unpins:
            self.assertRegex(path, r"^/channels/\d+/pins/\d+$")
            self.assertIsNone(body)
        for cid in migrate.CHATS:
            self.assertEqual(len(self.fake.messages[cid]), 2, cid)  # nothing deleted, nothing posted
            mine = [m for m in self.fake.messages[cid] if m["author"]["id"] == BOT]
            self.assertFalse(mine[0]["pinned"], cid)
        text = {path.split("/")[2]: body["content"] for _m, path, body in edits}
        fc_forum = self.channel_id("Development", "flight-controllers")
        self.assertTrue(text[FC].startswith(f"Chat for flight controllers. Structured posts, one per change, go in "
                                            f"<#{fc_forum}>."), text[FC])
        self.assertIn(f"<#{self.channel_id('Development', 'firmware')}>", text[BETAFLIGHT_CH])
        self.assertIn(f"<#{self.channel_id('Community', 'builds')}>", text[BUILD_CHAT])
        self.assertIn(f"<#{self.channel_id('Community', 'proposals')}>", text["1494033189532860707"])
        self.assertIn(f"<#{self.channel_id('Support', 'help')}>", text["1497547403140530237"])
        self.assertTrue(text[ROLES_CH].startswith("Roles are picked in <id:customize>"), text[ROLES_CH])
        self.assertNotIn("<#", text[MOTORS])
        before = len(self.fake.writes())
        out = self.ok("unarchive", "--yes")
        self.assertEqual(len(self.fake.writes()), before)
        self.assertIn("unarchive: 0 to update, 19 done", out)

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
        fake = MigrationFake(copy.deepcopy(PREVIOUS))
        for cid in migrate.CHATS:
            fake.messages[cid] = [notice(cid)]
        out = self.ok("unarchive", fake=fake)
        self.assertIn("19 blocked", out)
        self.assertIn("blocked #build-chat: not yet #build-chat in Community", out)
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
        fake = MigrationFake(copy.deepcopy(PREVIOUS))
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
        fake = MigrationFake(copy.deepcopy(PREVIOUS))
        fake.messages[BETAFLIGHT_CH] = [msg(NOW_MS - DAY_MS, "100")]
        out = self.ok("backfill", "--channel", "fc-betaflight", fake=fake)
        self.assertIn("Betaflight user: 1 member, role does not exist yet", out)
        code, _out, _err = self.run_cli("backfill", "--channel", "fc-betaflight", "--yes", fake=fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes(), [])


class Checklist(Case):
    def test_steps_in_order_without_a_token(self):
        out = self.ok("checklist", fake=object())
        order = ["discord_config.py apply --yes", "Paste the Server Guide copy", "migrate.py unarchive --yes",
                 "migrate.py firmware-roles --yes", "backfill --only-user", "migrate.py backfill --yes", "carl-bot",
                 "linked roles", "2FA"]
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
