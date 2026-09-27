#!/usr/bin/env python3
"""Posts and keeps up to date the texts the bot owns: #rules, #welcome, the
Server Guide resource pages and one hub per public repository.

Every subcommand is a dry run unless --yes, and a rerun writes nothing that is
already done: the bot's own messages are found by author and first line and
edited in place. The REST client is discord_config.py's, which refuses DELETE.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import discord_config as dc

AUDIT_REASON = "OpenDrone-hw/discord texts.py"
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
PAGE = 100  # Discord's maximum for GET /channels/{id}/messages
HISTORY_PAGES = 5  # how far back a message that is not pinned is looked for
CUSTOMIZE = "<id:customize>"  # opens Channels & Roles

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
- Order, payment, shipping, warranty or returns: a ticket at https://opendrone.be/support. Only the Incutec team reads it, and no Discord account is needed.
- A board that does not work: {#help}, where other pilots and the team answer in public and the answer stays findable. Anything with your order or personal details goes in a ticket instead.
- Design questions about a board: that board's channel under Hardware
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
Orders, payment, shipping and warranty: a private ticket at https://opendrone.be/support""",
}


def load_repos(path: Path = REPOS_JSON) -> dict:
    """bot/config/repos.json: the organisation, lifecycle names and repository -> product channel."""
    return json.loads(path.read_text(encoding="utf-8"))


# --- server state ----------------------------------------------------------


class Server:
    """Live channels and roles resolved against server.json, plus the writes this tool makes."""

    def __init__(self, api, desired: dict, sleep=None, fetch=None):
        self.api, self.desired = api, desired
        self.gid = desired["guild_id"]
        self.sleep = sleep or time.sleep
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

    def history(self, cid: str, pages: int):
        """Messages newest first, at most `pages` pages."""
        before, read = None, 0
        while read < pages:
            query = f"?limit={PAGE}" + (f"&before={before}" if before else "")
            batch = self.api.request("GET", f"/channels/{cid}/messages{query}") or []
            read += 1
            yield from batch
            if len(batch) < PAGE:
                return
            before = min(batch, key=lambda m: int(m["id"]))["id"]

    def find(self, cid: str, wanted: dict[str, callable]) -> dict[str, dict]:
        """The bot's own messages in a channel, found by content: {key: test(content) -> bool}. Pins first,
        then the newest HISTORY_PAGES pages of history (an unpinned message sinks as members post).
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
            for msg in self.history(cid, pages=HISTORY_PAGES):
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
    """discord_config.py's REST client with this tool's audit log reason."""

    def __init__(self, tok: str, urlopen=None, sleep=None):
        super().__init__(tok, urlopen=urlopen, sleep=sleep)
        self.headers["X-Audit-Log-Reason"] = AUDIT_REASON


def client(tok: str, urlopen=None, sleep=None) -> Client:
    return Client(tok, urlopen=urlopen, sleep=sleep)


def plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def dry_run_footer(yes: bool, what: str) -> None:
    if not yes:
        print(f"\nDry run. Re-run with --yes to {what}.")


# --- subcommands -----------------------------------------------------------


def show(text: str) -> None:
    print("\n".join("  " + line for line in text.splitlines()))


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


def sync_messages(server: Server, cid: str, texts: list[str], yes: bool, pin: bool) -> dict[str, int]:
    """Post and edit the bot messages `texts` in one channel, in order, and with `pin` pin the ones not yet
    pinned. A message is the bot's own one with the same first line. Returns counts: post, edit, pin, done."""
    counts = {"post": 0, "edit": 0, "pin": 0, "done": 0}
    have = server.find(cid, {first_line(t): (lambda text, f=first_line(t): first_line(text) == f) for t in texts})
    for text in texts:
        first = first_line(text)
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
    by_channel: dict[str, list[str]] = {}
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
        by_channel.setdefault(entry["channel"], []).append(text)
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
    wanted = parts
    if len({first_line(part) for part in wanted}) < len(wanted):
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
        counts = sync_messages(server, ch["id"], [text], args.yes, pin=False)
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


# --- entry point -----------------------------------------------------------


def main(argv=None, api=None, sleep=None, fetch=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=dc.ROOT / "server.json")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("hubs", help="post and pin one hub message per public repository in its product channel")
    p.add_argument("--yes", action="store_true")
    p.add_argument("--repos", type=Path, default=REPOS_JSON, help="bot/config/repos.json")
    p = sub.add_parser("resources", help="post one message in each Server Guide resource channel and in #welcome")
    p.add_argument("--yes", action="store_true")
    p = sub.add_parser("rules", help='post and pin the "4. #rules" section of a markdown file in #rules')
    p.add_argument("--yes", action="store_true")
    p.add_argument("--rules-file", type=Path, required=True, metavar="MD")
    args = parser.parse_args(argv)
    try:
        if args.command == "rules":
            try:
                rules_section(args.rules_file.read_text(encoding="utf-8"))
            except OSError as exc:
                raise dc.ConfigError(f"--rules-file: {exc.strerror}") from exc
        desired = dc.load_desired(args.config)
        api = api or client(dc.token())
        server = Server(api, desired, sleep, fetch)
        {"hubs": cmd_hubs, "rules": cmd_rules, "resources": cmd_resources}[args.command](args, server)
    except dc.ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
