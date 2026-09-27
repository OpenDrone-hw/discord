"""texts.py against an offline server: the live shape from test_server_json with the layout live before
this one applied, then server.json applied on top.

No network. Messages and pins are simulated on top of FakeDiscord.
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
from test_server_json import BUILDS, DESIRED, GID, current_desired, fake_state, live_state

import texts

NOW_MS = 1_790_000_000_000  # 2026-09-21
DAY_MS = 86_400_000
BOT = "1553826696673759344"
FC = "1494783056026796262"
_seq = iter(range(1, 1 << 22))


def sf(ms: int) -> str:
    return str(((ms - dc.DISCORD_EPOCH_MS) << 22) | next(_seq))


def msg(ms, author, content="hi", bot=False, **extra):
    user = {"id": author, "bot": True} if bot else {"id": author}
    m = {"id": sf(ms), "type": 0, "content": content, "author": user, "pinned": False}
    m.update(extra)
    return m


class MigrationFake(FakeDiscord):
    """FakeDiscord plus channel messages and pins."""

    def __init__(self, state):
        super().__init__(state)
        self.messages = {}  # channel id -> list of messages

    def request(self, method, path, body=None):
        routes = [
            ("GET", r"/channels/(\d+)/messages\?limit=(\d+)(?:&before=(\d+))?", self.get_messages),
            ("GET", r"/channels/(\d+)/pins", self.get_pins),
            ("PATCH", r"/channels/(\d+)/messages/(\d+)", self.patch_message),
            ("POST", r"/channels/(\d+)/messages", self.post_message),
            ("PUT", r"/channels/(\d+)/pins/(\d+)", self.put_pin),
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

    def post_message(self, m):
        self.chan(m.group(1))
        assert self.body["allowed_mentions"] == {"parse": []}
        assert len(self.body["content"]) <= 2000
        posted = msg(NOW_MS, self.bot_user_id, self.body["content"], bot=True)
        self.messages.setdefault(m.group(1), []).append(posted)
        return copy.deepcopy(posted)

    def put_pin(self, m):
        self.message(m.group(1), m.group(2))["pinned"] = True

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


class Case(unittest.TestCase):
    def setUp(self):
        self.fake = MigrationFake(copy.deepcopy(APPLIED))
        self.sleeps = []

    def run_cli(self, *argv, fake=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = texts.main(["--config", str(ROOT / "server.json"), *argv], api=fake or self.fake,
                                sleep=self.sleeps.append)
        return code, out.getvalue(), err.getvalue()

    def ok(self, *argv, fake=None):
        code, out, err = self.run_cli(*argv, fake=fake)
        self.assertEqual(code, 0, out + err)
        return out

    def channel_id(self, category, name):
        cat = next(c["id"] for c in self.fake.channels if c["type"] == 4 and c["name"] == category)
        return next(c["id"] for c in self.fake.channels if c["name"] == name and c.get("parent_id") == cat)


REPOS = texts.load_repos()


class FakeGitHub:
    """GET repos/<org>/<name> answers from a dict; None (404) for anything else. Records every path."""

    def __init__(self):
        self.calls = []
        self.meta = {repo: {"private": False, "description": f"{repo}: an open  design\n",
                            "topics": ["kicad", "status-beta"]}
                     for repo in REPOS["repos"] if repo not in texts.PRIVATE_REPOS}
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
            code = texts.main(["--config", str(ROOT / "server.json"), *argv], api=fake or self.fake,
                                sleep=self.sleeps.append, fetch=self.github)
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
        for repo in texts.PRIVATE_REPOS:
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
            self.assertEqual(body["flags"], texts.SUPPRESS_EMBEDS)
            by_channel.setdefault(path.split("/")[2], []).append(body["content"])
        self.assertEqual([t.split("\n")[0] for t in by_channel[FC]], [
            "## [OpenFC-Lite](https://github.com/OpenDrone-hw/OpenFC-Lite)",
            "## [OpenFC-Lite-Mini](https://github.com/OpenDrone-hw/OpenFC-Lite-Mini)"])
        self.assertEqual(by_channel[FC][0], "\n".join([
            "## [OpenFC-Lite](https://github.com/OpenDrone-hw/OpenFC-Lite)",
            "OpenFC-Lite: an open design",
            "Lifecycle: beta",
            "Releases: https://github.com/OpenDrone-hw/OpenFC-Lite/releases",
            "Discuss changes in threads: the bot opens one per pull request; link an existing thread with /link."]))
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

    def test_a_members_message_is_never_taken_for_the_hub(self):
        fake_hub = "## [OpenFC-Lite](https://github.com/OpenDrone-hw/OpenFC-Lite)\nx"
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
        text = texts.hub_text("OpenDrone-hw", "X", {"description": "> A \u2014 B\u2014C", "topics": []}, labels)
        self.assertIn("\nA, B-C\nReleases: ", text)
        self.assertNotIn("Lifecycle", text)  # no status-* topic: no lifecycle line at all
        text = texts.hub_text("OpenDrone-hw", "X", {"topics": ["status-alpha", "status-planned"]}, labels)
        self.assertEqual(text.split("\n")[1], "Lifecycle: alpha")
        self.assertNotIn("\u2014", text)

    def test_gh_fetch_maps_404_to_none_and_refuses_other_errors(self):
        def run(returncode, stdout="", stderr=""):
            return mock.Mock(returncode=returncode, stdout=stdout, stderr=stderr)

        with mock.patch.object(texts.subprocess, "run", return_value=run(0, '{"private": false}')) as call:
            self.assertEqual(texts.gh_fetch("repos/OpenDrone-hw/X"), {"private": False})
            self.assertEqual(call.call_args[0][0], ["gh", "api", "repos/OpenDrone-hw/X"])
        with mock.patch.object(texts.subprocess, "run", return_value=run(1, stderr="gh: Not Found (HTTP 404)")):
            self.assertIsNone(texts.gh_fetch("repos/OpenDrone-hw/X"))
        with mock.patch.object(texts.subprocess, "run", return_value=run(1, stderr="HTTP 401: Bad credentials")):
            with self.assertRaises(dc.ConfigError):
                texts.gh_fetch("repos/OpenDrone-hw/X")


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
        self.assertEqual(texts.rules_section(RULES_MD),
                         "**OpenDrone rules**\n\n1. Argue about problems, not people.\n2. Use the right channel.")
        self.assertEqual(texts.rules_section("### 4. #rules\n**OpenDrone rules**\n\n---\n### 5. x\n"),
                         "**OpenDrone rules**")
        for bad, why in (("## 3. x\n", "no heading"), ("## 4. #rules\n\n## 5. x", "empty"),
                         ("## 4. #rules\nPlain text.\n", "must start with the line **OpenDrone rules**"),
                         ("## 4. #rules\nA \u2014 B\n", "em dash"), ("## 4. #rules\n> quoted\n", "blockquote")):
            with self.assertRaises(dc.ConfigError, msg=bad) as ctx:
                texts.rules_section(bad)
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
        self.assertEqual(writes[0][2]["content"], texts.rules_section(RULES_MD))
        out = self.ok("rules", "--rules-file", self.md(), "--yes")
        self.assertEqual(len(self.fake.writes()), 2)
        self.assertIn("0 to post, 0 to edit, 0 to pin, 1 done", out)
        self.ok("rules", "--rules-file", self.md(RULES_MD.replace("people.", "people, ever.")), "--yes")
        self.assertEqual([c[0] for c in self.fake.writes()[2:]], ["PATCH"])

    def test_long_rules_are_split_at_paragraphs(self):
        paragraphs = "\n\n".join(f"{i}. " + "x" * 900 for i in range(1, 4))
        md = self.md(f"## 4. #rules\n\n**OpenDrone rules**\n\n{paragraphs}\n")
        out = self.ok("rules", "--rules-file", md, "--yes")
        self.assertIn("rules: 2 messages", out)
        posts = [c[2]["content"] for c in self.fake.writes() if c[0] == "POST"]
        self.assertTrue(posts[0].startswith("**OpenDrone rules**\n\n1. ") and posts[1].startswith("3. "))
        out = self.ok("rules", "--rules-file", md, "--yes")
        self.assertIn("0 to post, 0 to edit, 0 to pin, 2 done", out)

    def test_channel_placeholders_become_links_and_bare_names_are_refused(self):
        help_id = next(c["id"] for c in self.fake.channels if c["name"] == "help" and c["type"] == 15)
        md = RULES_MD.replace("2. Use the right channel.", "2. Product help goes in {#help}; builds in {#builds}.")
        self.ok("rules", "--rules-file", self.md(md), "--yes")
        posted = self.fake.writes()[0][2]["content"]
        self.assertIn(f"goes in <#{help_id}>; builds in <#{BUILDS}>.", posted)
        code, _out, err = self.run_cli("rules", "--rules-file", self.md(md.replace("{#help}", "#help")))
        self.assertEqual(code, 1)
        self.assertIn("write {#help} instead of #help", err)
        code, _out, err = self.run_cli("rules", "--rules-file", self.md(md.replace("{#help}", "{#nowhere}")))
        self.assertEqual(code, 1)
        self.assertIn("{#nowhere} names no channel", err)

    def test_a_bad_file_fails_before_any_request(self):
        code, _out, err = self.run_cli("rules", "--rules-file", self.md("nothing here"), fake=object())
        self.assertEqual(code, 1)
        self.assertIn('no heading "4. #rules"', err)
        code, _out, err = self.run_cli("rules", "--rules-file", str(Path(self.tmp.name) / "missing.md"), fake=object())
        self.assertEqual(code, 1)
        self.assertIn("--rules-file", err)


class Resources(Case):
    CHANNELS = ["how-to-contribute", "product-lifecycle", "buying-and-support", "licence-and-ai", "welcome"]

    def test_dry_run_writes_nothing(self):
        out = self.ok("resources")
        self.assertEqual(self.fake.writes(), [])
        self.assertIn("resources: 5 to post, 0 to edit, 0 done, 0 channel(s) blocked; nothing is pinned", out)
        self.assertIn("## Welcome to OpenDrone", out)
        self.assertIn("Dry run", out)

    def test_posts_one_message_per_channel_once_and_pins_nothing(self):
        self.ok("resources", "--yes")
        writes = self.fake.writes()
        self.assertEqual([c[0] for c in writes], ["POST"] * 5)
        by_channel = {self.fake.chan(c[1].split("/")[2])["name"]: c[2] for c in writes}
        self.assertEqual(sorted(by_channel), sorted(self.CHANNELS))
        heads = {name: body["content"].split("\n", 1)[0] for name, body in by_channel.items()}
        self.assertEqual(heads, {"how-to-contribute": "## How to contribute", "product-lifecycle": "## Product lifecycle",
                                 "buying-and-support": "## Buying and support",
                                 "licence-and-ai": "## Licence, names and AI", "welcome": "## Welcome to OpenDrone"})
        help_id = next(c["id"] for c in self.fake.channels if c["name"] == "help" and c["type"] == 15)
        for name, body in by_channel.items():
            text = body["content"]
            self.assertEqual((body["allowed_mentions"], body["flags"]), ({"parse": []}, texts.SUPPRESS_EMBEDS))
            self.assertLessEqual(len(text), 2000, name)
            self.assertNotIn("{#", text, name)
            self.assertNotIn("\u2014", text, name)
            self.assertFalse(re.search(r"^>", text, re.M), name)
        self.assertIn(f"<#{help_id}>", by_channel["buying-and-support"]["content"])
        self.assertNotIn("#support", by_channel["buying-and-support"]["content"])
        welcome = by_channel["welcome"]["content"]
        self.assertIn("<id:customize>", welcome)
        self.assertIn("https://opendrone.be/support", welcome)
        self.assertTrue(4 <= len(welcome.splitlines()) - 1 <= 6)
        self.assertEqual(len(self.sleeps), 5)
        self.assertFalse(any(m["pinned"] for ms in self.fake.messages.values() for m in ms))
        out = self.ok("resources", "--yes")
        self.assertEqual(len(self.fake.writes()), 5)
        self.assertIn("resources: 0 to post, 0 to edit, 5 done", out)

    def test_a_changed_body_is_edited_in_place_and_a_pinned_message_stays_as_it_is(self):
        self.ok("resources", "--yes")
        welcome = self.channel_id("Start", "welcome")
        self.fake.messages[welcome][0]["pinned"] = True
        changed = dict(texts.RESOURCES, welcome=texts.RESOURCES["welcome"] + "\nOne more line.")
        with mock.patch.object(texts, "RESOURCES", changed):
            out = self.ok("resources", "--yes")
        new = self.fake.writes()[5:]
        self.assertEqual([(c[0], c[1].split("/")[2]) for c in new], [("PATCH", welcome)])
        self.assertIn("resources: 0 to post, 1 to edit, 4 done", out)
        self.assertTrue(self.fake.messages[welcome][0]["pinned"])

    def test_blocked_before_the_layout_is_applied(self):
        fake = MigrationFake(copy.deepcopy(CURRENT))
        out = self.ok("resources", fake=fake)
        self.assertIn("blocked #how-to-contribute: the channel does not exist yet", out)
        code, _out, err = self.run_cli("resources", "--yes", fake=fake)
        self.assertEqual(code, 1)
        self.assertIn("Apply server.json first", err)
        self.assertEqual(fake.writes(), [])


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

        api = texts.client("TOKEN", urlopen=urlopen, sleep=sleeps.append)
        server = texts.Server(api, DESIRED, sleep=sleeps.append)
        body = {"content": "hello", "allowed_mentions": {"parse": []}}
        self.assertEqual(server.write("PATCH", "/channels/7/messages/8", body)["id"], "8")
        self.assertEqual(sleeps, [2.1, texts.WRITE_DELAY])
        server.write("PUT", "/channels/7/pins/8")
        self.assertEqual([r.get_method() for r in requests[-2:]], ["PATCH", "PUT"])
        for req in requests:
            self.assertEqual(req.get_header("X-audit-log-reason"), texts.AUDIT_REASON)

    def test_delete_is_refused(self):
        api = texts.client("TOKEN", urlopen=lambda *a, **k: self.fail("no request may be sent"))
        for path in ("/channels/7", "/channels/7/messages/8", "/channels/7/pins/8", f"/guilds/{GID}/members/5/roles/9"):
            with self.assertRaises(dc.ConfigError, msg=path):
                api.request("DELETE", path)


if __name__ == "__main__":
    unittest.main()
