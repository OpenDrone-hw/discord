#!/usr/bin/env python3
"""Member-facing steps that follow applying the server.json layout.

Every subcommand is a dry run unless --yes, and a rerun writes nothing that is
already done: a rerun finds the bot's own messages by author and first line, and
role changes skip members who already have the result. Nothing is deleted.
The REST client is discord_config.py's with one exception: DELETE is allowed
only to unpin a message and to take a role off a member.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import discord_config as dc

AUDIT_REASON = "OpenDrone-hw/discord migrate.py"
# Earlier runs ended every bot message with a visible "-# <mark>" line. Messages are now found by author
# and first line; these marks are only read, so messages from those runs are still recognised and a rerun
# edits the line away.
LEGACY_MARKER = "opendrone-migration"
NOTICE_MARK = f"{LEGACY_MARKER}:notice-1"  # the archive notice the earlier notices step posted and pinned
UNARCHIVE_MARK = f"{LEGACY_MARKER}:unarchive-1"  # the same message after unarchive edited it
HUB_MARK = f"{LEGACY_MARKER}:hub-1"  # followed by the repository name
RULES_MARK = f"{LEGACY_MARKER}:rules-1"  # followed by the part number
RULES_TITLE = "**OpenDrone rules**"  # first line of the rules text: finds its first message in #rules
MENTION = re.compile(r"\{#([a-z0-9_-]+)\}")  # {#name} in a text the bot posts -> <#channel id>
BARE_CHANNEL = re.compile(r"(?<![<{\w&#])#([a-z0-9][a-z0-9_-]*)")
REPOS_JSON = dc.ROOT / "bot" / "config" / "repos.json"
# Private repositories get no hub: nothing of theirs is posted to Discord. A repository GitHub reports
# as private or answers 404 for is skipped as well.
PRIVATE_REPOS = ("OpenFC", "OpenGPS", "OpenFrame-3F", "OpenFrame-5F")
LIFECYCLE_TOPICS = ("status-planned", "status-in-progress", "status-alpha", "status-beta", "status-launched")
HUB_FOOTER = "Discuss changes in threads: the bot opens one per pull request; link an existing thread with /link."
MESSAGE_LIMIT = 2000
SUPPRESS_EMBEDS = 1 << 2
WRITE_DELAY = 0.5  # seconds after every write, on top of the client's 429 and bucket handling
PAGE = 100  # Discord's maximum for GET /channels/{id}/messages and the audit log
NOTICE_PAGES = 5  # how far back unarchive looks for a notice that is no longer pinned
USER_MESSAGE_TYPES = {0, 19}  # default and reply; joins, pins and other system messages are not authorship
CUSTOMIZE = "<id:customize>"  # opens Channels & Roles
MEMBER_ROLE_UPDATE = 25  # audit log action type
ROLLOUT_START = "2026-09-27T16:40:00Z"  # onboarding with the Firmware prompt went live
# DELETE paths the client allows; neither removes a message, channel or role.
UNDO_PATHS = (re.compile(r"/channels/\d+/pins/\d+"), re.compile(r"/guilds/\d+/members/\d+/roles/\d+"))

# The firmware team roles belong to the projects' maintainers. The Firmware onboarding prompt and
# backfill give the matching "user" role instead; firmware-roles moves members over.
FIRMWARE_ROLES = {"Betaflight": "Betaflight user", "AM32": "AM32 user", "ExpressLRS": "ExpressLRS user"}

# Channel id -> (name before the Archive migration, name in server.json, what the chat is for, follower role).
# The archive notice in each is rewritten by unarchive; backfill grants the follower role to recent authors.
# Tests check the names against server.json and each follower role against the onboarding option that
# points at the channel.
CHATS = {
    "1494033189532860707": ("proposals", "proposals", "proposals for new products and changes", None),
    "1494782854117326969": ("builds", "builds", "builds", None),
    "1494783056026796262": ("fc", "fc", "flight controllers", "FC follower"),
    "1538618173354414190": ("aio", "aio", "AIO boards", "FC follower"),
    "1494782966302507118": ("esc", "esc", "ESCs", "ESC follower"),
    "1494758332903456969": ("rx", "rx", "receivers", "RX follower"),
    "1494758396577058900": ("vtx", "vtx", "video transmitters", "Video follower"),
    "1494803018770809065": ("digital-vtx", "digital-vtx", "digital video", "Video follower"),
    "1494758377010757682": ("remote-id", "remote-id", "Remote ID", "RemoteID-GPS follower"),
    "1550883307246461033": ("gps", "gps", "GPS", "RemoteID-GPS follower"),
    "1494758355825328158": ("frame", "frame", "frames", "Frame follower"),
    "1550884618322972693": ("charger", "charger", "chargers", "Power follower"),
    "1550883427220197396": ("motors", "motors", "motors", None),  # no OpenDrone motor product line
    "1494758297885212832": ("esc-am32", "esc-am32", "AM32", "AM32 user"),
    "1494783023114096821": ("fc-betaflight", "fc-betaflight", "Betaflight", "Betaflight user"),
    "1550882869839134810": ("rx-expresslrs", "rx-expresslrs", "ExpressLRS", "ExpressLRS user"),
    "1494796004615131237": ("opendrone-web", "opendrone-web", "opendrone.be and the web tools", "Web-Tools follower"),
}

# One message per channel, posted and kept up to date by `resources`, never pinned. The first line of each
# identifies the message on a rerun; {#name} becomes a channel link. The four resource channels are the
# Server Guide's resource pages; #welcome gets the orientation message.
RESOURCES = {
    "how-to-contribute": """\
## How to contribute
You don't need permission. Just say what you're up to.

1. Say it on Discord. Post what you want to change in the channel for that board. Someone may already be working on it, or may have experience or good ideas.
2. Fork it and change it. Work on a branch, not on main.
```sh
gh repo fork OpenDrone-hw/<repo> --clone
git checkout -b my-change
```
3. Open a pull request. Say what you changed and why.
4. Someone reviews it. Discuss problems openly in the right channel.

You do not have to design anything to be useful. Reading a schematic and asking "why is this pull-up 10k" is a real contribution.

KiCad files cannot be merged. If two people edit the same .kicad_pcb or .kicad_sch, one of them loses their work. Say what you are editing before you start.

Full guide: https://github.com/OpenDrone-hw/.github/blob/main/CONTRIBUTING.md""",
    "product-lifecycle": """\
## Product lifecycle
Every repo starts as a copy of hardware-template. Its status-* topic on GitHub shows how far along it is and drives the roadmap on opendrone.be.

- **1 Planned**, not buyable: the specification exists. Needs research, parts, opinions.
- **2 In progress**, not buyable: the design is being drawn. Needs drawing, review.
- **3 Alpha**, preorder only: boards made, in community testing. Needs flying it, breaking it.
- **4 Beta**, on sale as the first batch: needs reports from real use.
- **5 Launched**, on sale: the design will not change. A change from here is a new product.

Admins and the Incutec team change the status, because it changes the website.

Anyone can propose a new product: post a paragraph of what and why in {#proposals}. Want to help test an alpha board? Ask for a sample.

Roadmap: https://opendrone.be/roadmap""",
    "buying-and-support": """\
## Buying and support
The products are sold at https://opendrone.be. Incutec handles production, quality control, parts sourcing, packing and shipping, and the legal responsibility for a product sold.

Alpha boards may be offered as a preorder against a funding target. The first production batch is built once the target is met.

Where to go:
- Order, payment or shipping: https://opendrone.be/support
- Technical questions about a board: {#help}, or that board's channel under Hardware
- Firmware: Betaflight, AM32 and ExpressLRS are upstream open source projects. OpenDrone boards run them unchanged where possible. Use the channels under Software.
- Anything that should be findable later: a GitHub issue on the relevant repo""",
    "licence-and-ai": """\
## Licence, names and AI
Hardware is CERN-OHL-S-2.0, a reciprocal copyleft licence. You can modify a board and ship your version. If someone asks for your sources, you hand them over on the same terms. The goal is not to stop clones but for everyone to share their improvements.

incutec is a registered trademark. OpenDrone is not. Build the designs, sell them, call them what you like. You cannot present your product as an official incutec product, or use incutec branding in a way that suggests we made, tested or support it. Saying what your board is based on is fine.

Some bundled 3D models have their own upstream licence (CC-BY-SA-4.0 or GPL), noted inside the file. Those notices still apply.

Licence text: https://ohwr.org/cern_ohl_s_v2.txt

### AI usage
You are responsible for what you commit. If you do not personally understand what an AI did and why, do not commit it.

What it is used for: research and datasheet reading, component search and sourcing, BOM work, library management, running ERC and DRC checks and explaining the results, documentation, and project management.

What it does not do (yet): make schematics, place parts or route a board.""",
    "welcome": f"""\
## Welcome to OpenDrone
This server is where OpenDrone, a fully open source FPV stack, is developed, tested and supported.
Start with {{#rules}}, say hi in {{#introduce-yourself}}, ask board questions in {{#help}} and propose products or changes in {{#proposals}}.
Pick the product channels you follow in Channels & Roles: {CUSTOMIZE}
Development happens in the product channels, one thread per pull request. For every GitHub pull request, merge and release in one channel, pick GitHub feed in Channels & Roles.
Orders, payment and shipping: https://opendrone.be/support""",
}


SERVER_GUIDE = """\
Welcome sign
  OpenDrone builds open source FPV hardware in public. Pick what you follow,
  read the rules, then say hi.

New member to-dos (title / channel / description)
  1. Read the rules / #rules / Short, and they apply everywhere
  2. Say hi / #introduce-yourself / What you fly and what you build
  3. Pick what you follow / Channels & Roles / Product lines, what you fly, firmware
  4. Show your build / #builds / A photo and the parts list
  5. Ask for help / help / Product, revision, firmware and what you tried

Resource pages (channel / card description); the bodies are posted by migrate.py resources
  #how-to-contribute / No permission needed. Say it here, fork, open a pull request.
  #product-lifecycle / Planned, in progress, alpha, beta, launched. The status-* topic on each repo.
  #buying-and-support / Where to buy, where to ask, who does what.
  #licence-and-ai / CERN-OHL-S-2.0. incutec is a trademark, OpenDrone is not."""


def load_repos(path: Path = REPOS_JSON) -> dict:
    """bot/config/repos.json: the organisation, lifecycle names and repository -> product channel."""
    return json.loads(path.read_text(encoding="utf-8"))


def chat_text(line: str, product: bool) -> str:
    """product is True for a channel repos.json maps repositories to."""
    if product:
        return f"Chat for {line}. Pull requests in the public repositories of this line get a thread here."
    return f"Chat for {line}."


# --- server state ----------------------------------------------------------


class Server:
    """Live channels and roles resolved against server.json, plus the writes this tool makes."""

    def __init__(self, api, desired: dict, sleep=None, clock=None, fetch=None):
        self.api, self.desired = api, desired
        self.gid = desired["guild_id"]
        self.sleep = sleep or time.sleep
        self.clock = clock or time.time
        self.fetch = fetch or gh_fetch  # GitHub REST GET: path -> JSON, None for 404
        self.bot_id = api.request("GET", "/users/@me")["id"]
        self.channels = api.request("GET", f"/guilds/{self.gid}/channels")
        self.by_id = {c["id"]: c for c in self.channels}
        self.roles = {r["name"]: r for r in api.request("GET", f"/guilds/{self.gid}/roles")}

    def category_id(self, cat: dict) -> str | None:
        if cat.get("id") in self.by_id:
            return cat["id"]
        parents = [c["id"] for c in self.channels if c["type"] == 4 and c["name"] == cat["name"]]
        return parents[0] if len(parents) == 1 else None

    def managed(self, name: str) -> dict | None:
        """The live channel for one server.json category channel, matched like discord_config.py does."""
        hits = [(cat, ch) for cat in self.desired["categories"] for ch in cat.get("channels", [])
                if ch["name"] == name]
        if len(hits) != 1:
            raise dc.ConfigError(f"server.json: {name!r} must be exactly one channel in categories")
        cat, ch = hits[0]
        if ch.get("id"):
            return self.by_id.get(ch["id"])
        parent = self.category_id(cat)
        if parent is None:
            return None
        ctype = dc.CHANNEL_TYPES[ch.get("type", "text")]
        found = [c for c in self.channels
                 if c["name"] == name and c["type"] == ctype and c.get("parent_id") == parent]
        return found[0] if len(found) == 1 else None

    def placed(self, cid: str) -> str | None:
        """Why a channel listed by id in server.json is not where server.json puts it, or None."""
        hits = [(cat, ch) for cat in self.desired["categories"] for ch in cat.get("channels", [])
                if ch.get("id") == cid]
        if len(hits) != 1:
            raise dc.ConfigError(f"server.json: channel {cid} must be listed by id exactly once in categories")
        cat, ch = hits[0]
        live = self.by_id.get(cid)
        if live is None:
            return "the channel does not exist"
        if live["name"] != ch["name"] or live.get("parent_id") != self.category_id(cat):
            return f"not yet #{ch['name']} in {cat['name']}"
        return None

    def history(self, cid: str, pages: int | None = None, after_ms: int | None = None):
        """Messages newest first, stopping at the page limit or the first message older than after_ms."""
        before, read = None, 0
        while pages is None or read < pages:
            query = f"?limit={PAGE}" + (f"&before={before}" if before else "")
            batch = self.api.request("GET", f"/channels/{cid}/messages{query}") or []
            read += 1
            for msg in batch:
                if after_ms is not None and snowflake_ms(msg["id"]) < after_ms:
                    return
                yield msg
            if len(batch) < PAGE:
                return
            before = min(batch, key=lambda m: int(m["id"]))["id"]

    def notice(self, cid: str, first: str) -> dict | None:
        """The bot's archive notice in a channel: before unarchive rewrote it (the notice mark), after an
        earlier run rewrote it (the unarchive mark) or after this version did (first line `first`)."""
        def mine(text):
            return NOTICE_MARK in text or UNARCHIVE_MARK in text or text.split("\n", 1)[0] == first

        return self.find(cid, {"notice": mine}).get("notice")

    def find(self, cid: str, wanted: dict[str, callable]) -> dict[str, dict]:
        """The bot's own messages in a channel, found by content: {key: test(content) -> bool}. Pins first,
        then the newest NOTICE_PAGES pages of history (an unpinned message sinks as members post).
        {key: message}, the first message found per key; a message by anyone else never matches."""
        found: dict[str, dict] = {}

        def take(msg):
            if msg.get("author", {}).get("id") != self.bot_id:
                return
            text = msg.get("content") or ""
            for key, test in wanted.items():
                if key not in found and test(text):
                    found[key] = msg
                    return

        for msg in self.api.request("GET", f"/channels/{cid}/pins") or []:
            take(msg)
        if len(found) < len(wanted):
            for msg in self.history(cid, pages=NOTICE_PAGES):
                take(msg)
        return found

    def mention(self, name: str, where: str) -> str:
        """<#id> for a channel name: the server.json channel of that name, else the one live channel."""
        listed = [ch for cat in self.desired["categories"] for ch in cat.get("channels", []) if ch["name"] == name]
        live = self.managed(name) if len(listed) == 1 else None
        if live is None:
            hits = [c for c in self.channels if c["name"] == name and c["type"] != 4]
            live = hits[0] if len(hits) == 1 else None
            if len(hits) > 1:
                raise dc.ConfigError(f"{where}: {{#{name}}} matches {len(hits)} channels")
        if live is None:
            raise dc.ConfigError(f"{where}: {{#{name}}} names no channel on the server")
        return f"<#{live['id']}>"

    def mentions(self, text: str, where: str) -> str:
        """Every {#name} replaced by <#id>. A bare #name of an existing channel is refused: it would not be
        clickable in the message."""
        names = {c["name"] for c in self.channels if c["type"] != 4}
        bare = sorted({m for m in BARE_CHANNEL.findall(text) if m in names})
        if bare:
            raise dc.ConfigError(f"{where}: write {', '.join('{#' + n + '}' for n in bare)} instead of "
                                 f"{', '.join('#' + n for n in bare)} so the channel is a link")
        return MENTION.sub(lambda m: self.mention(m.group(1), where), text)

    def write(self, method: str, path: str, body=None):
        result = self.api.request(method, path, body)
        self.sleep(WRITE_DELAY)
        return result


class Client(dc.Discord):
    """discord_config.py's REST client with this tool's audit log reason. DELETE is allowed only on
    UNDO_PATHS: unpinning a message and taking a role off a member."""

    def __init__(self, tok: str, urlopen=None, sleep=None):
        super().__init__(tok, urlopen=urlopen, sleep=sleep)
        self.headers["X-Audit-Log-Reason"] = AUDIT_REASON

    def allowed(self, method: str, path: str) -> bool:
        return super().allowed(method, path) or (method == "DELETE" and any(p.fullmatch(path) for p in UNDO_PATHS))


def client(tok: str, urlopen=None, sleep=None) -> Client:
    return Client(tok, urlopen=urlopen, sleep=sleep)


def snowflake_ms(sid: str) -> int:
    return (int(sid) >> 22) + dc.DISCORD_EPOCH_MS


def plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def label(server: Server, cid: str) -> str:
    ch = server.by_id.get(cid)
    return "#" + (ch["name"] if ch else CHATS.get(cid, (cid,))[0])


def dry_run_footer(yes: bool, what: str) -> None:
    if not yes:
        print(f"\nDry run. Re-run with --yes to {what}.")


# --- subcommands -----------------------------------------------------------


def show(text: str) -> None:
    print("\n".join("  " + line for line in text.splitlines()))


def cmd_unarchive(args, server: Server) -> None:
    product = {entry["channel"] for entry in load_repos()["repos"].values()}
    ready, blocked = [], []
    for cid, (_old, name, line, _role) in CHATS.items():
        why = server.placed(cid)
        if why:
            blocked.append(f"#{name}: {why}")
            continue
        ready.append((cid, name, chat_text(line, name in product)))
    for line in blocked:
        print(f"  blocked {line}")
    if blocked and args.yes:
        raise dc.ConfigError(f"{len(blocked)} channel(s) not ready. Apply server.json first; nothing was written")
    todo = done = missing = 0
    for cid, name, text in ready:
        msg = server.notice(cid, text.split("\n", 1)[0])
        if msg is None:
            missing += 1
            print(f"  #{name}: no notice found, nothing to do")
            continue
        steps = (["edit"] if msg.get("content") != text else []) + (["unpin"] if msg.get("pinned") else [])
        if not steps:
            done += 1
            print(f"  #{name}: notice rewritten and unpinned, nothing to do")
            continue
        todo += 1
        print(f"  #{name}: {' and '.join(steps)} the notice")
        if args.yes:
            if "edit" in steps:
                server.write("PATCH", f"/channels/{cid}/messages/{msg['id']}",
                             {"content": text, "allowed_mentions": {"parse": []}})
            if "unpin" in steps:
                server.write("DELETE", f"/channels/{cid}/pins/{msg['id']}")
    print(f"\nunarchive: {todo} to update, {done} done, {missing} without a notice, {len(blocked)} blocked")
    if not args.yes:
        print("\nNew text in #fc:\n")
        show(chat_text(CHATS["1494783056026796262"][2], True))
    if todo:
        dry_run_footer(args.yes, "edit and unpin them")


# --- pinned messages: repository hubs and the rules --------------------------


def gh_fetch(path: str) -> dict | None:
    """GitHub REST GET through the gh CLI and its own login; None for 404."""
    try:
        run = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise dc.ConfigError(f"gh api {path}: {exc}") from exc
    if run.returncode != 0:
        if "HTTP 404" in run.stderr or "Not Found" in run.stderr:
            return None
        raise dc.ConfigError(f"gh api {path}: {run.stderr.strip()[:200]}")
    return json.loads(run.stdout)


def one_line(text: str) -> str:
    """Collapsed whitespace, no em dashes, no leading quote marker."""
    clean = re.sub(r"\s+", " ", text).strip().replace(" \u2014 ", ", ").replace("\u2014", "-")
    return clean.lstrip("> ").strip()


def lifecycle(topics: list[str], labels: dict[str, str]) -> str | None:
    """Name of the most advanced status-* topic, or None."""
    status = None
    for topic in LIFECYCLE_TOPICS:
        if topic in topics:
            status = topic
    return labels.get(status, status) if status else None


def hub_first_line(org: str, repo: str) -> str:
    """The first line of a repository's hub message; it identifies the hub on a rerun."""
    return f"## [{repo}](https://github.com/{org}/{repo})"


def hub_text(org: str, repo: str, meta: dict, labels: dict[str, str]) -> str:
    url = f"https://github.com/{org}/{repo}"
    status = lifecycle(meta.get("topics") or [], labels)
    lines = [hub_first_line(org, repo)]
    description = one_line(meta.get("description") or "")
    if description:
        lines.append(description[:300])
    if status:
        lines.append(f"Lifecycle: {status}")
    lines += [f"Releases: {url}/releases", HUB_FOOTER]
    return "\n".join(lines)


def first_line(text: str) -> str:
    return text.split("\n", 1)[0]


def identified_by(first: str, legacy: str | None = None):
    """Test for server.find: the message starts with `first`, or ends with the legacy mark line."""
    def test(text: str) -> bool:
        return first_line(text) == first or (legacy is not None and text.rsplit("\n", 1)[-1] == f"-# {legacy}")
    return test


def sync_messages(server: Server, cid: str, wanted: list[tuple[str, str | None, str]], yes: bool,
                  pin: bool) -> dict[str, int]:
    """Post and edit the bot messages `wanted` [(first line, legacy mark or None, text)] in one channel, in
    order, and with `pin` pin the ones not yet pinned. A message is the bot's own one whose first line
    matches, or whose last line is the legacy mark. Returns counts: post, edit, pin, done."""
    counts = {"post": 0, "edit": 0, "pin": 0, "done": 0}
    have = server.find(cid, {first: identified_by(first, legacy) for first, legacy, _text in wanted})
    for first, _legacy, text in wanted:
        msg = have.get(first)
        body = {"content": text, "allowed_mentions": {"parse": []}, "flags": SUPPRESS_EMBEDS}
        if msg is None:
            counts["post"] += 1
            counts["pin"] += pin
            if yes:
                posted = server.write("POST", f"/channels/{cid}/messages", body)
                if pin:
                    server.write("PUT", f"/channels/{cid}/pins/{posted['id']}")
            continue
        edit, repin = msg.get("content") != text, pin and not msg.get("pinned")
        counts["edit"] += edit
        counts["pin"] += repin
        counts["done"] += not (edit or repin)
        if yes and edit:
            server.write("PATCH", f"/channels/{cid}/messages/{msg['id']}", body)
        if yes and repin:
            server.write("PUT", f"/channels/{cid}/pins/{msg['id']}")
    return counts


def cmd_hubs(args, server: Server) -> None:
    repos = load_repos(args.repos)
    org, labels = repos["org"], repos.get("lifecycle", {})
    by_channel: dict[str, list[tuple[str, str | None, str]]] = {}
    private = missing = 0
    sample = None
    for repo, entry in repos["repos"].items():
        if repo in PRIVATE_REPOS:
            private += 1
            continue
        meta = server.fetch(f"repos/{org}/{repo}")
        if meta is None:
            missing += 1
            continue
        if meta.get("private") is not False:
            private += 1
            continue
        text = hub_text(org, repo, meta, labels)
        if len(text) > MESSAGE_LIMIT:
            raise dc.ConfigError(f"hub for {repo}: {len(text)} characters, over Discord's {MESSAGE_LIMIT}")
        sample = sample or text
        by_channel.setdefault(entry["channel"], []).append((hub_first_line(org, repo), f"{HUB_MARK} {repo}", text))
    ready, blocked = [], []
    for name, wanted in by_channel.items():
        ch = server.managed(name)
        (ready if ch else blocked).append((name, ch, wanted))
    for name, _ch, wanted in blocked:
        print(f"  blocked #{name}: the channel does not exist yet (apply server.json first), {plural(len(wanted), 'hub')}")
    if blocked and args.yes:
        raise dc.ConfigError(f"{len(blocked)} channel(s) missing. Apply server.json first; nothing was written")
    total = {"post": 0, "edit": 0, "pin": 0, "done": 0}
    for name, ch, wanted in ready:
        counts = sync_messages(server, ch["id"], wanted, args.yes, pin=True)
        for key in total:
            total[key] += counts[key]
        print(f"  #{name}: {plural(len(wanted), 'hub')}, {counts['post']} to post, {counts['edit']} to edit, "
              f"{counts['pin']} to pin, {counts['done']} done")
    print(f"\nhubs: {total['post']} to post, {total['edit']} to edit, {total['pin']} to pin, {total['done']} done; "
          f"{private} private skipped, {missing} not found on GitHub, {len(blocked)} channel(s) blocked")
    if not args.yes and sample:
        print("\nFirst hub:\n")
        show(sample)
    if total["post"] or total["edit"] or total["pin"]:
        dry_run_footer(args.yes, "post, edit and pin them")


def rules_section(markdown: str) -> str:
    """The text of the section headed "4. #rules": the fenced block in it when there is one."""
    lines = markdown.splitlines()
    start = next((i for i, line in enumerate(lines) if re.fullmatch(r"#{1,6}\s*4\.\s*#rules\s*", line.strip())), None)
    if start is None:
        raise dc.ConfigError('--rules-file: no heading "4. #rules"')
    level = len(lines[start]) - len(lines[start].lstrip("#"))
    body = []
    for line in lines[start + 1:]:
        heading = re.match(r"(#{1,6})\s", line)
        if heading and len(heading.group(1)) <= level:
            break
        body.append(line)
    text = "\n".join(body)
    fence = re.search(r"^```[^\n]*\n(.*?)^```", text, re.S | re.M)
    text = fence.group(1) if fence else re.sub(r"^\s*---\s*$", "", text, flags=re.M)
    text = text.strip()
    if not text:
        raise dc.ConfigError('--rules-file: the "4. #rules" section is empty')
    if "\u2014" in text or re.search(r"^>", text, re.M):
        raise dc.ConfigError("--rules-file: the rules text holds an em dash or a blockquote; fix the source first")
    if first_line(text) != RULES_TITLE:
        raise dc.ConfigError(f"--rules-file: the rules text must start with the line {RULES_TITLE}; "
                             "it identifies the rules message on a rerun")
    return text


def split_parts(text: str, room: int) -> list[str]:
    """Paragraph-aligned parts of at most `room` characters."""
    parts, current = [], ""
    for para in text.split("\n\n"):
        if len(para) > room:
            raise dc.ConfigError(f"--rules-file: a paragraph of {len(para)} characters does not fit one message")
        joined = f"{current}\n\n{para}" if current else para
        if len(joined) > room:
            parts.append(current)
            joined = para
        current = joined
    return parts + [current]


def cmd_rules(args, server: Server) -> None:
    text = server.mentions(rules_section(args.rules_file.read_text(encoding="utf-8")), "--rules-file")
    parts = split_parts(text, MESSAGE_LIMIT)
    # Part 1 starts with RULES_TITLE; a later part is found by its own first line.
    wanted = [(first_line(part), f"{RULES_MARK} {i}", part) for i, part in enumerate(parts, 1)]
    if len({first for first, _mark, _part in wanted}) < len(wanted):
        raise dc.ConfigError("--rules-file: two messages of the rules text start with the same line")
    ch = server.managed("rules")
    if ch is None:
        raise dc.ConfigError("#rules does not exist")
    counts = sync_messages(server, ch["id"], wanted, args.yes, pin=True)
    print(f"rules: {plural(len(wanted), 'message')} ({len(text)} characters), {counts['post']} to post, "
          f"{counts['edit']} to edit, {counts['pin']} to pin, {counts['done']} done")
    if not args.yes:
        print("\nText:\n")
        show(text)
    if counts["post"] or counts["edit"] or counts["pin"]:
        dry_run_footer(args.yes, "post, edit and pin it")


def cmd_resources(args, server: Server) -> None:
    ready, blocked = [], []
    for name, body in RESOURCES.items():
        ch = server.managed(name)
        if ch is None:
            blocked.append(name)
            continue
        text = server.mentions(body, f"#{name}")
        if len(text) > MESSAGE_LIMIT:
            raise dc.ConfigError(f"#{name}: {len(text)} characters, over Discord's {MESSAGE_LIMIT}")
        ready.append((name, ch, text))
    for name in blocked:
        print(f"  blocked #{name}: the channel does not exist yet (apply server.json first)")
    if blocked and args.yes:
        raise dc.ConfigError(f"{len(blocked)} channel(s) missing. Apply server.json first; nothing was written")
    total = {"post": 0, "edit": 0, "done": 0}
    for name, ch, text in ready:
        counts = sync_messages(server, ch["id"], [(first_line(text), None, text)], args.yes, pin=False)
        for key in total:
            total[key] += counts[key]
        state = "to post" if counts["post"] else "to edit" if counts["edit"] else "done"
        print(f"  #{name}: {len(text)} characters, {state}")
    print(f"\nresources: {total['post']} to post, {total['edit']} to edit, {total['done']} done, "
          f"{len(blocked)} channel(s) blocked; nothing is pinned")
    if not args.yes and ready:
        name, _ch, text = ready[-1] if ready[-1][0] == "welcome" else ready[0]
        print(f"\nText in #{name}:\n")
        show(text)
    if total["post"] or total["edit"]:
        dry_run_footer(args.yes, "post and edit them")


def parse_since(value: str) -> int:
    """ISO 8601 timestamp (UTC when no offset is given) -> Unix milliseconds."""
    try:
        when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise dc.ConfigError(f"--since {value!r}: not an ISO 8601 timestamp") from exc
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return int(when.timestamp() * 1000)


def role_adds(server: Server, since_ms: int, team: dict[str, str]):
    """(member id, team role name, how) for each audit log $add of a team role since since_ms. how is
    "picked" (the member, through onboarding or Channels & Roles), "backfill" (this tool, recognised by its
    audit log reason) or "moderator" (anyone else, the bot's other code included)."""
    before = None
    while True:
        query = f"?action_type={MEMBER_ROLE_UPDATE}&limit={PAGE}" + (f"&before={before}" if before else "")
        entries = server.api.request("GET", f"/guilds/{server.gid}/audit-logs{query}")["audit_log_entries"]
        for entry in entries:
            if snowflake_ms(entry["id"]) < since_ms:
                return
            target, actor = entry.get("target_id"), entry.get("user_id")
            backfill = actor == server.bot_id and entry.get("reason") == AUDIT_REASON
            how = "picked" if actor == target else "backfill" if backfill else "moderator"
            for change in entry.get("changes") or []:
                if change.get("key") != "$add":
                    continue
                for r in change.get("new_value") or []:
                    if r.get("id") in team and target:
                        yield target, team[r["id"]], how
        if len(entries) < PAGE:
            return
        before = min(entries, key=lambda e: int(e["id"]))["id"]


def cmd_firmware_roles(args, server: Server) -> None:
    since_ms = parse_since(args.since)
    missing = [n for pair in FIRMWARE_ROLES.items() for n in pair if n not in server.roles]
    problems = [f"{n} {why}" for n in FIRMWARE_ROLES.values() if n in server.roles and (why := grantable(server, n))]
    team = {server.roles[n]["id"]: n for n in FIRMWARE_ROLES if n in server.roles}
    mode = "dry run" if not args.yes else "moving"
    print(f"firmware-roles: team roles added since {args.since}, {mode}")
    for n in missing:
        print(f"  blocked: role {n} does not exist (apply server.json first)")
    for text in problems:
        print(f"  blocked: {text}")
    if (missing or problems) and args.yes:
        raise dc.ConfigError("apply server.json first; nothing was changed")
    counts = {n: {"picked": set(), "backfill": set(), "moderator": set()} for n in FIRMWARE_ROLES}
    for uid, name, how in role_adds(server, since_ms, team):
        counts[name][how].add(uid)
    wanted: dict[str, set[str]] = {}  # member id -> team role names to move
    for name, by in counts.items():
        move = (by["picked"] | by["backfill"]) - by["moderator"]  # a moderator's grant is deliberate
        for uid in move:
            wanted.setdefault(uid, set()).add(name)
        print(f"  {name} -> {FIRMWARE_ROLES[name]}: {plural(len(move), 'member')} to move "
              f"(picked {len(by['picked'])}, backfill {len(by['backfill'])}), "
              f"{plural(len(by['moderator']), 'member')} given it by a moderator left alone")
    if not args.yes:
        if wanted:
            print("With --yes, members who left or already have the result are skipped.")
            dry_run_footer(False, "move them")
        return
    result = {n: {"removed": 0, "not held": 0, "granted": 0, "held": 0, "left": 0} for n in FIRMWARE_ROLES}
    for uid, names in wanted.items():
        try:
            member = server.api.request("GET", f"/guilds/{server.gid}/members/{uid}")
        except dc.HTTPError as exc:
            if exc.status != 404:
                raise
            for name in names:
                result[name]["left"] += 1
            continue
        held = set(member.get("roles", []))
        for name in sorted(names):
            team_id, user_id = server.roles[name]["id"], server.roles[FIRMWARE_ROLES[name]]["id"]
            if user_id in held:
                result[name]["held"] += 1
            else:
                server.write("PUT", f"/guilds/{server.gid}/members/{uid}/roles/{user_id}")
                result[name]["granted"] += 1
            if team_id in held:
                server.write("DELETE", f"/guilds/{server.gid}/members/{uid}/roles/{team_id}")
                result[name]["removed"] += 1
            else:
                result[name]["not held"] += 1
    print("\nmoved:")
    for name, r in result.items():
        print(f"  {name}: removed {r['removed']}, not held {r['not held']}; {FIRMWARE_ROLES[name]}: "
              f"granted {r['granted']}, already held {r['held']}; not in the server {r['left']}")


def backfill_channels(server: Server, only: list[str]) -> list[tuple[str, str]]:
    """(channel id, follower role name) for each development chat with a follower role, limited by --channel."""
    mapped = [(cid, chat[3]) for cid, chat in CHATS.items() if chat[3]]
    if not only:
        return mapped
    picked = []
    for ref in only:
        hits = [(cid, role) for cid, role in mapped
                if ref.lstrip("#") in (cid, CHATS[cid][0], CHATS[cid][1])]
        if not hits:
            raise dc.ConfigError(f"--channel {ref}: not a development chat with a follower role")
        picked += [h for h in hits if h not in picked]
    return picked


def grantable(server: Server, role_name: str) -> str | None:
    """Why a follower role must not be granted, or None."""
    role = server.roles.get(role_name)
    if role is None:
        return "does not exist yet (apply server.json first)"
    guard = server.desired.get("guard", {})
    blocked = set(guard.get("unassignable_roles", [])) | set(guard.get("protected_roles", ["admin"]))
    if role.get("managed") or role_name in blocked or int(role["permissions"]) & dc.PRIVILEGED_BITS:
        return "is managed, protected or privileged; refusing to grant it"
    return None


def cmd_backfill(args, server: Server) -> None:
    channels = backfill_channels(server, args.channel)
    cutoff = int(server.clock() * 1000) - args.days * 86_400_000
    mode = "dry run" if not args.yes else "granting"
    scope = ", one given member only" if args.only_user else ""
    print(f"backfill: authors of the last {args.days} days, {mode}{scope}")
    wanted: dict[str, set[str]] = {}  # user id -> role names
    per_role: dict[str, set[str]] = {}
    for cid, role_name in channels:
        if cid not in server.by_id:
            print(f"  {label(server, cid)}: channel not found, skipped")
            continue
        messages, authors = 0, set()
        for msg in server.history(cid, after_ms=cutoff):
            author = msg.get("author") or {}
            if msg.get("type", 0) not in USER_MESSAGE_TYPES or msg.get("webhook_id") \
                    or author.get("bot") or author.get("system") or not author.get("id"):
                continue
            messages += 1
            if args.only_user and author["id"] != args.only_user:
                continue
            authors.add(author["id"])
        print(f"  {label(server, cid)} -> {role_name}: {plural(messages, 'member message')}, "
              f"{plural(len(authors), 'author')}")
        per_role.setdefault(role_name, set()).update(authors)
        for uid in authors:
            wanted.setdefault(uid, set()).add(role_name)
    problems = {name: why for name in per_role if (why := grantable(server, name))}
    print("\nroles:")
    for name, users in per_role.items():
        print(f"  {name}: {plural(len(users), 'member')}"
              + (f", role {problems[name]}" if name in problems else ""))
    grants = sum(len(r) for r in wanted.values())
    print(f"\ntotal: {plural(len(wanted), 'member')}, at most {plural(grants, 'role grant')}")
    if args.only_user and not wanted:
        print("The given member has no messages in these channels in this window; nothing to grant.")
    if not args.yes:
        if grants:
            print("With --yes, members who left or already hold the role are skipped.")
            dry_run_footer(False, "grant the roles")
        return
    if problems:
        raise dc.ConfigError("refusing to grant: " + "; ".join(f"{n} {w}" for n, w in problems.items()))
    result = {name: {"granted": 0, "held": 0, "left": 0} for name in per_role}
    for uid, role_names in wanted.items():
        try:
            member = server.api.request("GET", f"/guilds/{server.gid}/members/{uid}")
        except dc.HTTPError as exc:
            if exc.status != 404:
                raise
            for name in role_names:
                result[name]["left"] += 1
            continue
        held = set(member.get("roles", []))
        for name in sorted(role_names):
            rid = server.roles[name]["id"]
            if rid in held:
                result[name]["held"] += 1
                continue
            server.write("PUT", f"/guilds/{server.gid}/members/{uid}/roles/{rid}")
            result[name]["granted"] += 1
    print("\ngranted:")
    for name, r in result.items():
        print(f"  {name}: granted {r['granted']}, already held {r['held']}, not in the server {r['left']}")


def cmd_checklist(args) -> None:
    steps = [
        ("Apply the layout",
         ["python3 discord_config.py plan", "python3 discord_config.py apply --yes   # only after the plan was seen"]),
        ("Delete the retired empty channels by hand: right-click the channel > Delete Channel",
         ["The forums the plan lists as unmanaged (builds and proposals forums, flight-controllers, escs,",
          "receivers, video, remote-id-gps, frames, power, library, firmware, web-and-tools) and #support-chat.",
          "Check each has no member posts first. The tools never delete; never touch #web-support or",
          "#web-support-admin. Then discord_config.py plan lists only those two as unmanaged."]),
        ("Paste the Server Guide copy: Server Settings > Onboarding > Server Guide",
         ["Copy below. Discord has no API for the Server Guide. Take #roles off the guide, then delete",
          "#roles by hand (it holds the old reaction roles and is no longer in server.json)."]),
        ("Post the Server Guide resource pages and the #welcome orientation message (not pinned)",
         ["python3 migrate.py resources", "python3 migrate.py resources --yes"]),
        ("Post and pin the rules in #rules",
         ["python3 migrate.py rules --rules-file <copy.md>", "python3 migrate.py rules --rules-file <copy.md> --yes"]),
        ("Post and pin one hub message per public repository in its product channel",
         ["python3 migrate.py hubs", "python3 migrate.py hubs --yes"]),
        ("Rewrite and unpin the archive notices in the restored chats",
         ["python3 migrate.py unarchive", "python3 migrate.py unarchive --yes"]),
        ("Move self-picked firmware team roles to the user roles",
         ["python3 migrate.py firmware-roles", "python3 migrate.py firmware-roles --yes"]),
        ("Backfill follower roles on one test member, check that account's roles, then everyone",
         ["python3 migrate.py backfill --only-user <your user id>",
          "python3 migrate.py backfill --only-user <your user id> --yes",
          "python3 migrate.py backfill", "python3 migrate.py backfill --yes"]),
        ("Remove carl-bot: Server Settings > Integrations > carl-bot > Kick",
         ["It only gives Newbie on join and runs the #roles reaction roles; onboarding replaces both.",
          "Keep the Newbie and Member roles."]),
        ("Attach linked roles: Server Settings > Roles > the role > Links > add OpenDrone Dev",
         ["Contributor: merged_prs at least 1", "Maintainer: maintainer is true",
          "Verified Owner: owner is true (any paid order on opendrone.be, preorders included;"
          " the storefront fills it, until then it is 0 for everyone)"]),
        ("Re-enable 2FA: Server Settings > Safety Setup > Require 2FA for moderator actions",
         ["Only after the OpenDrone Dev application moved to a Developer Team whose owner has 2FA;",
          "then check the bot still writes."]),
    ]
    for i, (title, lines) in enumerate(steps, 1):
        print(f"{i}. {title}")
        for line in lines:
            print(f"     {line}")
    print("\nServer Guide copy\n")
    print("\n".join("  " + line for line in SERVER_GUIDE.splitlines()))


# --- entry point -----------------------------------------------------------


def main(argv=None, api=None, sleep=None, clock=None, fetch=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=dc.ROOT / "server.json")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("unarchive", help="rewrite and unpin the archive notice in each restored chat")
    p.add_argument("--yes", action="store_true")
    p = sub.add_parser("firmware-roles", help="move members who picked a firmware team role to its user role")
    p.add_argument("--yes", action="store_true")
    p.add_argument("--since", default=ROLLOUT_START, metavar="ISO",
                   help=f"read role adds from this time on (default {ROLLOUT_START}, the onboarding rollout)")
    p = sub.add_parser("backfill", help="grant follower roles to recent authors of the development chats")
    p.add_argument("--yes", action="store_true")
    p.add_argument("--days", type=int, default=90)
    p.add_argument("--only-user", metavar="ID", help="grant only to this one member (test mode)")
    p.add_argument("--channel", action="append", default=[], metavar="NAME_OR_ID",
                   help="limit to this development chat; repeatable")
    p = sub.add_parser("hubs", help="post and pin one hub message per public repository in its product channel")
    p.add_argument("--yes", action="store_true")
    p.add_argument("--repos", type=Path, default=REPOS_JSON, help="bot/config/repos.json")
    p = sub.add_parser("resources", help="post one message in each Server Guide resource channel and in #welcome")
    p.add_argument("--yes", action="store_true")
    p = sub.add_parser("rules", help='post and pin the "4. #rules" section of a markdown file in #rules')
    p.add_argument("--yes", action="store_true")
    p.add_argument("--rules-file", type=Path, required=True, metavar="MD")
    sub.add_parser("checklist", help="print the manual migration steps in order")
    args = parser.parse_args(argv)
    try:
        if args.command == "checklist":
            cmd_checklist(args)
            return 0
        if args.command == "backfill":
            if args.days < 1:
                raise dc.ConfigError("--days must be at least 1")
            if args.only_user and not args.only_user.isdigit():
                raise dc.ConfigError("--only-user takes a numeric user id")
        if args.command == "firmware-roles":
            parse_since(args.since)
        if args.command == "rules":
            try:
                rules_section(args.rules_file.read_text(encoding="utf-8"))
            except OSError as exc:
                raise dc.ConfigError(f"--rules-file: {exc.strerror}") from exc
        desired = dc.load_desired(args.config)
        api = api or client(dc.token())
        server = Server(api, desired, sleep, clock, fetch)
        {"unarchive": cmd_unarchive, "firmware-roles": cmd_firmware_roles, "backfill": cmd_backfill,
         "hubs": cmd_hubs, "rules": cmd_rules, "resources": cmd_resources}[args.command](args, server)
    except dc.ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
