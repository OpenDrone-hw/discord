"""migrate.py against an offline server: the live shape from test_server_json with server.json applied.

No network. Messages, pins and members are simulated on top of FakeDiscord.
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
from test_server_json import DESIRED, GID, live_state

import migrate

NOW_MS = 1_790_000_000_000  # 2026-09-21
DAY_MS = 86_400_000
BOT = "1553748824470851644"
FC = "1494783056026796262"
AIO = "1538618173354414190"
ESC = "1494782966302507118"
ROLES_CH = "1494780931498705057"
ANNOUNCEMENTS = "1494032474626326548"
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

    def request(self, method, path, body=None):
        g = f"/guilds/{self.gid}"
        routes = [
            ("GET", r"/channels/(\d+)/messages\?limit=(\d+)(?:&before=(\d+))?", self.get_messages),
            ("POST", r"/channels/(\d+)/messages", self.post_message),
            ("PUT", r"/channels/(\d+)/pins/(\d+)", self.put_pin),
            ("GET", g + r"/members/(\d+)", self.get_member),
            ("PUT", g + r"/members/(\d+)/roles/(\d+)", self.put_member_role),
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

    def post_message(self, m):
        self.chan(m.group(1))
        new = {"id": sf(NOW_MS), "type": 0, "content": self.body["content"], "author": {"id": self.bot_user_id, "bot": True},
               "pinned": False}
        self.messages.setdefault(m.group(1), []).append(new)
        return copy.deepcopy(new)

    def put_pin(self, m):
        hit = [x for x in self.messages.get(m.group(1), []) if x["id"] == m.group(2)]
        if not hit:
            raise dc.HTTPError("HTTP 404 Unknown Message", 404)
        hit[0]["pinned"] = True

    def get_member(self, m):
        if m.group(1) not in self.members:
            raise dc.HTTPError("HTTP 404 Unknown Member", 404)
        return {"user": {"id": m.group(1)}, "roles": sorted(self.members[m.group(1)])}

    def put_member_role(self, m):
        if m.group(1) not in self.members:
            raise dc.HTTPError("HTTP 404 Unknown Member", 404)
        assert any(r["id"] == m.group(2) for r in self.roles), m.group(2)
        self.members[m.group(1)].add(m.group(2))

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]

    def role_id(self, name):
        return self.role_by_name(name)["id"]


def applied_state():
    """The live shape after `discord_config.py apply --yes` of the real server.json."""
    fake = FakeDiscord(live_state())
    with tempfile.TemporaryDirectory() as tmp, mock.patch.object(dc, "SNAPSHOTS", Path(tmp)), \
            contextlib.redirect_stdout(io.StringIO()):
        assert dc.main(["--config", str(ROOT / "server.json"), "apply", "--yes"], api=fake) == 0
    return {"guild_id": fake.gid, "bot_user_id": fake.bot_user_id, "guild": fake.guild, "roles": fake.roles,
            "emojis": fake.emojis, "channels": fake.channels, "onboarding": fake.onboarding,
            "welcome_screen": fake.welcome, "automod": fake.automod}


APPLIED = applied_state()


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


class Mapping(unittest.TestCase):
    def test_every_archived_channel_has_one_entry(self):
        self.assertEqual(set(migrate.SUCCESSORS), set(DESIRED["archive"]["channels"]))

    def test_successors_are_managed_channels(self):
        names = [ch["name"] for cat in DESIRED["categories"] for ch in cat["channels"]]
        for cid, (old, successor, _role) in migrate.SUCCESSORS.items():
            if successor != migrate.CUSTOMIZE:
                self.assertEqual(names.count(successor), 1, (old, successor))

    def test_ping_roles_come_from_the_onboarding_option_for_the_successor(self):
        options = [o for p in DESIRED["onboarding"]["prompts"] for o in p["options"]]
        for cid, (old, successor, role) in migrate.SUCCESSORS.items():
            if role:
                self.assertTrue(any(role in o.get("roles", []) and successor in o.get("channels", [])
                                    for o in options), (old, successor, role))

    def test_old_names_match_the_live_shape(self):
        live = {c["id"]: c["name"] for c in live_state()["channels"]}
        for cid, (old, _s, _r) in migrate.SUCCESSORS.items():
            self.assertEqual(live[cid], old)


class Announce(Case):
    def test_dry_run_writes_nothing(self):
        out = self.ok("announce")
        self.assertEqual(self.fake.writes(), [])
        self.assertIn("Dry run", out)
        self.assertIn("<id:customize>", out)

    def test_posts_once_without_mentions(self):
        self.ok("announce", "--yes")
        writes = self.fake.writes()
        self.assertEqual(len(writes), 1)
        method, path, body = writes[0]
        self.assertEqual((method, path), ("POST", f"/channels/{ANNOUNCEMENTS}/messages"))
        self.assertEqual(body["allowed_mentions"], {"parse": []})
        text = body["content"]
        for part in ("<id:customize>", "<id:guide>", migrate.ANNOUNCE_MARK,
                     f"<#{self.channel_id('Support', 'help')}>", f"<#{self.channel_id('Community', 'builds')}>",
                     f"<#{self.channel_id('Community', 'proposals')}>"):
            self.assertIn(part, text)
        self.assertEqual(self.sleeps, [migrate.WRITE_DELAY])
        out = self.ok("announce", "--yes")
        self.assertIn("already posted", out)
        self.assertEqual(len(self.fake.writes()), 1)

    def test_a_members_message_with_the_marker_does_not_count(self):
        self.fake.messages[ANNOUNCEMENTS] = [msg(NOW_MS - DAY_MS, "42", migrate.ANNOUNCE_MARK)]
        self.ok("announce", "--yes")
        self.assertEqual(len(self.fake.writes()), 1)

    def test_blocked_before_the_layout_is_applied(self):
        fake = MigrationFake(live_state())
        out = self.ok("announce", fake=fake)
        self.assertIn("blocked", out)
        code, out, err = self.run_cli("announce", "--yes", fake=fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes(), [])


class Notices(Case):
    def test_dry_run_writes_nothing(self):
        out = self.ok("notices")
        self.assertEqual(self.fake.writes(), [])
        self.assertIn("notices: 19 to write, 0 done, 0 blocked", out)

    def test_posts_and_pins_once_per_archived_channel(self):
        self.ok("notices", "--yes")
        posts = [c for c in self.fake.writes() if c[0] == "POST"]
        pins = [c for c in self.fake.writes() if c[0] == "PUT"]
        self.assertEqual(len(posts), 19)
        self.assertEqual(len(pins), 19)
        self.assertEqual(len(self.sleeps), 38)
        for cid in migrate.SUCCESSORS:
            mine = [m for m in self.fake.messages[cid] if migrate.NOTICE_MARK in m["content"]]
            self.assertEqual(len(mine), 1, cid)
            self.assertTrue(mine[0]["pinned"], cid)
        by_channel = {path.split("/")[2]: body for _m, path, body in posts}
        fc_forum = self.channel_id("Development", "flight-controllers")
        self.assertIn(f"<#{fc_forum}>", by_channel[FC]["content"])
        self.assertIn(f"<#{fc_forum}>", by_channel[AIO]["content"])
        self.assertIn("<id:customize>", by_channel[ROLES_CH]["content"])
        self.assertNotIn("<#", by_channel[ROLES_CH]["content"])
        for body in by_channel.values():
            self.assertEqual(body["allowed_mentions"], {"parse": []})
        before = len(self.fake.writes())
        out = self.ok("notices", "--yes")
        self.assertEqual(len(self.fake.writes()), before)
        self.assertIn("0 to write, 19 done", out)

    def test_pins_an_existing_unpinned_notice_instead_of_posting_again(self):
        old = msg(NOW_MS - DAY_MS, BOT, "x\n-# " + migrate.NOTICE_MARK, bot=True)
        self.fake.messages[FC] = [old]
        self.ok("notices", "--yes")
        fc_writes = [c for c in self.fake.writes() if f"/channels/{FC}/" in c[1]]
        self.assertEqual(fc_writes, [("PUT", f"/channels/{FC}/pins/{old['id']}", None)])

    def test_blocked_before_the_layout_is_applied(self):
        fake = MigrationFake(live_state())
        out = self.ok("notices", fake=fake)
        self.assertIn("19 blocked", out)
        code, _out, _err = self.run_cli("notices", "--yes", fake=fake)
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
        self.assertIn("not an archived development channel", err)

    def test_refuses_a_privileged_or_missing_role(self):
        self.seed()
        self.fake.role_by_name("FC dev")["permissions"] = str(dc.PERMISSIONS["MANAGE_MESSAGES"])
        code, _out, err = self.run_cli("backfill", "--yes")
        self.assertEqual(code, 1)
        self.assertIn("FC dev", err)
        self.assertEqual(self.fake.writes(), [])
        fake = MigrationFake(live_state())
        fake.messages[FC] = [msg(NOW_MS - DAY_MS, "100")]
        out = self.ok("backfill", "--channel", "fc", fake=fake)
        self.assertIn("does not exist yet", out)
        code, _out, _err = self.run_cli("backfill", "--channel", "fc", "--yes", fake=fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes(), [])


class Checklist(Case):
    def test_steps_in_order_without_a_token(self):
        out = self.ok("checklist", fake=object())
        order = ["discord_config.py apply --yes", "migrate.py announce", "migrate.py notices",
                 "backfill --only-user", "migrate.py backfill --yes", "carl-bot", "Server Guide",
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
            "/channels/7/messages": [urllib.error.HTTPError("u", 429, "Too Many", {}, io.BytesIO(b'{"retry_after": 2}')),
                                     FakeResponse(b'{"id": "8"}')],
        }

        def urlopen(req, context=None, timeout=None):
            requests.append(req)
            item = responses[req.full_url.removeprefix(dc.API)].pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        api = migrate.client("TOKEN", urlopen=urlopen, sleep=sleeps.append)
        server = migrate.Server(api, DESIRED, sleep=sleeps.append)
        self.assertEqual(server.post("7", "hello")["id"], "8")
        self.assertEqual(sleeps, [2.1, migrate.WRITE_DELAY])
        for req in requests:
            self.assertEqual(req.get_header("X-audit-log-reason"), migrate.AUDIT_REASON)
        self.assertEqual(json.loads(requests[-1].data)["allowed_mentions"], {"parse": []})


if __name__ == "__main__":
    unittest.main()
