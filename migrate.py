#!/usr/bin/env python3
"""One-off member-facing steps that follow applying the server.json layout.

Every subcommand is a dry run unless --yes. Messages the bot posts carry a
marker line, so a rerun finds its own earlier message instead of posting a
second one; role grants skip members who already hold the role. Nothing is
deleted: the REST client from discord_config.py refuses DELETE.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import discord_config as dc

AUDIT_REASON = "OpenDrone-hw/discord migrate.py"
MARKER = "opendrone-migration"
ANNOUNCE_MARK = f"{MARKER}:announce-1"
NOTICE_MARK = f"{MARKER}:notice-1"
WRITE_DELAY = 0.5  # seconds after every write, on top of the client's 429 and bucket handling
PAGE = 100  # Discord's maximum for GET /channels/{id}/messages
ANNOUNCE_PAGES = 3  # how far back announce looks for its own earlier message
NOTICE_PAGES = 1  # archived channels are read-only, so a notice stays among the newest messages
USER_MESSAGE_TYPES = {0, 19}  # default and reply; joins, pins and other system messages are not authorship
CUSTOMIZE = "<id:customize>"  # opens Channels & Roles
GUIDE = "<id:guide>"  # opens the Server Guide
ANNOUNCE_CHANNELS = ("announcements", "help", "builds", "proposals")

# Archived channel id -> (old name, successor, ping role). The successor is a channel name from
# server.json's categories or CUSTOMIZE; the ping role is the role the onboarding option for that
# product line gives together with the successor forum. Tests check both against server.json.
SUCCESSORS = {
    "1494780931498705057": ("roles", CUSTOMIZE, None),
    "1494033189532860707": ("proposals", "proposals", None),
    "1494782854117326969": ("builds", "builds", None),
    "1497547403140530237": ("support", "help", None),
    "1494783056026796262": ("fc", "flight-controllers", "FC dev"),
    "1538618173354414190": ("aio", "flight-controllers", "FC dev"),
    "1494782966302507118": ("esc", "escs", "ESC dev"),
    "1494758332903456969": ("rx", "receivers", "RX dev"),
    "1494758396577058900": ("vtx", "video", "Video dev"),
    "1494803018770809065": ("digital-vtx", "video", "Video dev"),
    "1494758377010757682": ("remote-id", "remote-id-gps", "RemoteID-GPS dev"),
    "1550883307246461033": ("gps", "remote-id-gps", "RemoteID-GPS dev"),
    "1494758355825328158": ("frame", "frames", "Frame dev"),
    "1550884618322972693": ("charger", "power", "Power dev"),
    "1550883427220197396": ("motors", "gen-chat", None),  # no OpenDrone motor product line
    "1494758297885212832": ("esc-am32", "firmware", "AM32"),
    "1494783023114096821": ("fc-betaflight", "firmware", "Betaflight"),
    "1550882869839134810": ("rx-expresslrs", "firmware", "ExpressLRS"),
    "1494796004615131237": ("opendrone-web", "web-and-tools", "Web-Tools dev"),
}

SERVER_GUIDE = """\
Welcome sign
  OpenDrone builds open source FPV hardware in public. Pick what you follow,
  read the rules, then say hi.

New member to-dos (title / channel / description)
  1. Read the rules / #rules / Short, and they apply everywhere
  2. Say hi / #introduce-yourself / What you fly and what you build
  3. Pick what you follow / Channels & Roles / Product lines, what you fly, firmware
  4. Show your build / builds / A photo and the parts list
  5. Ask for help / help / Product, revision, firmware and what you tried

Resource pages
  #rules, #announcements, help"""


def announce_text(ids: dict) -> str:
    """ids maps help, builds and proposals to a channel mention such as <#123>."""
    return "\n".join([
        "**The OpenDrone server has been reorganised.**",
        f"- Pick what you follow in {CUSTOMIZE}: each product line has a development forum and a ping role,"
        " and you can add what you fly and the firmware you use.",
        f"- New here? The Server Guide is in {GUIDE}.",
        f"- Questions go to {ids['help']}, builds to {ids['builds']}, ideas to {ids['proposals']}.",
        "- The old channels are in the Archive category: read-only history, nothing was deleted.",
        f"-# {ANNOUNCE_MARK}",
    ])


def notice_text(successor: str | None) -> str:
    """successor is a channel mention such as <#123>, or None for #roles."""
    if successor is None:
        body = (f"Roles are now picked in {CUSTOMIZE} (Channels & Roles). The reaction roles in this channel"
                " stop working when the old role bot is removed.")
    else:
        body = f"Continue in {successor}. Pick the product lines you follow in {CUSTOMIZE}."
    return "\n".join(["**This channel is archived.** It stays as read-only history; nothing was deleted.",
                      body, f"-# {NOTICE_MARK}"])


# --- server state ----------------------------------------------------------


class Server:
    """Live channels and roles resolved against server.json, plus the writes this tool makes."""

    def __init__(self, api, desired: dict, sleep=None, clock=None):
        self.api, self.desired = api, desired
        self.gid = desired["guild_id"]
        self.sleep = sleep or time.sleep
        self.clock = clock or time.time
        self.bot_id = api.request("GET", "/users/@me")["id"]
        self.channels = api.request("GET", f"/guilds/{self.gid}/channels")
        self.by_id = {c["id"]: c for c in self.channels}
        self.roles = {r["name"]: r for r in api.request("GET", f"/guilds/{self.gid}/roles")}
        name = desired.get("archive", {}).get("category")
        cats = [c for c in self.channels if c["type"] == 4 and c["name"] == name]
        self.archive_id = cats[0]["id"] if len(cats) == 1 else None

    def managed(self, name: str) -> dict | None:
        """The live channel for one server.json category channel, matched like discord_config.py does."""
        hits = [(cat, ch) for cat in self.desired["categories"] for ch in cat.get("channels", [])
                if ch["name"] == name]
        if len(hits) != 1:
            raise dc.ConfigError(f"server.json: {name!r} must be exactly one channel in categories")
        cat, ch = hits[0]
        if ch.get("id"):
            return self.by_id.get(ch["id"])
        if cat.get("id") in self.by_id:
            parent = cat["id"]
        else:
            parents = [c["id"] for c in self.channels if c["type"] == 4 and c["name"] == cat["name"]]
            if len(parents) != 1:
                return None
            parent = parents[0]
        ctype = dc.CHANNEL_TYPES[ch.get("type", "text")]
        found = [c for c in self.channels
                 if c["name"] == name and c["type"] == ctype and c.get("parent_id") == parent]
        return found[0] if len(found) == 1 else None

    def archived(self, cid: str) -> bool:
        ch = self.by_id.get(cid)
        return bool(ch and self.archive_id and ch.get("parent_id") == self.archive_id)

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

    def own_message(self, cid: str, mark: str, pages: int) -> dict | None:
        for msg in self.history(cid, pages=pages):
            if msg.get("author", {}).get("id") == self.bot_id and mark in (msg.get("content") or ""):
                return msg
        return None

    def write(self, method: str, path: str, body=None):
        result = self.api.request(method, path, body)
        self.sleep(WRITE_DELAY)
        return result

    def post(self, cid: str, content: str) -> dict:
        return self.write("POST", f"/channels/{cid}/messages",
                          {"content": content, "allowed_mentions": {"parse": []}})

    def pin(self, cid: str, mid: str) -> None:
        self.write("PUT", f"/channels/{cid}/pins/{mid}")


def client(tok: str, urlopen=None, sleep=None):
    """discord_config.py's REST client with this tool's audit log reason."""
    api = dc.Discord(tok, urlopen=urlopen, sleep=sleep)
    api.headers["X-Audit-Log-Reason"] = AUDIT_REASON
    return api


def snowflake_ms(sid: str) -> int:
    return (int(sid) >> 22) + dc.DISCORD_EPOCH_MS


def plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def label(server: Server, cid: str) -> str:
    ch = server.by_id.get(cid)
    return "#" + (ch["name"] if ch else SUCCESSORS.get(cid, (cid,))[0])


def dry_run_footer(yes: bool, what: str) -> None:
    if not yes:
        print(f"\nDry run. Re-run with --yes to {what}.")


# --- subcommands -----------------------------------------------------------


def show(text: str) -> None:
    print("\n".join("  " + line for line in text.splitlines()))


def cmd_announce(args, server: Server) -> None:
    found = {name: server.managed(name) for name in ANNOUNCE_CHANNELS}
    missing = [f"#{name}" for name, ch in found.items() if ch is None]
    if server.archive_id is None:
        missing.append(f"category {server.desired.get('archive', {}).get('category')}")
    if missing:
        print(f"blocked: the layout is not applied yet, missing {', '.join(missing)}")
        if args.yes:
            raise dc.ConfigError("apply server.json first; nothing was posted")
        print("\nText, with channel names where the ids will go:\n")
        show(announce_text({name: f"#{name}" for name in ANNOUNCE_CHANNELS}))
        return
    target = found["announcements"]
    if target["type"] != dc.CHANNEL_TYPES["announcement"]:
        print(f"note: #{target['name']} is not an announcement channel yet")
    if server.own_message(target["id"], ANNOUNCE_MARK, ANNOUNCE_PAGES):
        print(f"announce: already posted in #{target['name']}, nothing to do")
        return
    text = announce_text({k: f"<#{v['id']}>" for k, v in found.items()})
    print(f"announce: post to #{target['name']}, no mentions:\n")
    show(text)
    if args.yes:
        server.post(target["id"], text)
        print(f"\nposted to #{target['name']}")
    dry_run_footer(args.yes, "post it")


def cmd_notices(args, server: Server) -> None:
    archive = server.desired.get("archive", {}).get("channels", [])
    ready, blocked = [], []
    for cid, (_old, successor, _role) in SUCCESSORS.items():
        if cid not in archive:
            raise dc.ConfigError(f"{label(server, cid)} ({cid}) is not in server.json's archive block")
        where = "Channels & Roles" if successor == CUSTOMIZE else f"#{successor}"
        if not server.archived(cid):
            blocked.append(f"{label(server, cid)} -> {where}: not in the archive category yet")
            continue
        target = None
        if successor != CUSTOMIZE:
            ch = server.managed(successor)
            if ch is None:
                blocked.append(f"{label(server, cid)} -> {where}: the successor does not exist yet")
                continue
            target = f"<#{ch['id']}>"
        ready.append((cid, where, target))
    for line in blocked:
        print(f"  blocked {line}")
    if blocked and args.yes:
        raise dc.ConfigError(f"{len(blocked)} channel(s) not ready. Apply server.json first; nothing was posted")
    todo = 0
    for cid, where, target in ready:
        name = label(server, cid)
        existing = server.own_message(cid, NOTICE_MARK, NOTICE_PAGES)
        if existing and existing.get("pinned"):
            print(f"  {name} -> {where}: notice posted and pinned, nothing to do")
            continue
        todo += 1
        if existing:
            print(f"  {name} -> {where}: pin the existing notice")
            if args.yes:
                server.pin(cid, existing["id"])
            continue
        print(f"  {name} -> {where}: post and pin a notice")
        if args.yes:
            msg = server.post(cid, notice_text(target))
            server.pin(cid, msg["id"])
    print(f"\nnotices: {todo} to write, {len(ready) - todo} done, {len(blocked)} blocked")
    if not args.yes:
        print("\nText, product line channels:\n")
        show(notice_text("#<successor>"))
        print("\nText, #roles:\n")
        show(notice_text(None))
    if todo:
        dry_run_footer(args.yes, "post and pin them")


def backfill_channels(server: Server, only: list[str]) -> list[tuple[str, str]]:
    """(channel id, ping role name) for each archived channel with a ping role, limited by --channel."""
    mapped = [(cid, role) for cid, (_o, _s, role) in SUCCESSORS.items() if role]
    if not only:
        return mapped
    picked = []
    for ref in only:
        hits = [(cid, role) for cid, role in mapped
                if ref in (cid, SUCCESSORS[cid][0], "#" + SUCCESSORS[cid][0])]
        if not hits:
            raise dc.ConfigError(f"--channel {ref}: not an archived development channel with a ping role")
        picked += [h for h in hits if h not in picked]
    return picked


def grantable(server: Server, role_name: str) -> str | None:
    """Why a ping role must not be granted, or None."""
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
        ("Paste the Server Guide copy: Server Settings > Onboarding > Server Guide",
         ["Copy below. Discord has no API for the Server Guide.",
          "Before announce: the live guide's first to-do sends members to #roles, which apply archives."]),
        ("Announce the reorganisation in #announcements",
         ["python3 migrate.py announce", "python3 migrate.py announce --yes"]),
        ("Post and pin a notice in each archived channel",
         ["python3 migrate.py notices", "python3 migrate.py notices --yes"]),
        ("Backfill ping roles on one test member, check that account's roles, then everyone",
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


def main(argv=None, api=None, sleep=None, clock=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=dc.ROOT / "server.json")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("announce", help="post the reorganisation message to #announcements")
    p.add_argument("--yes", action="store_true")
    p = sub.add_parser("notices", help="post and pin a successor notice in each archived channel")
    p.add_argument("--yes", action="store_true")
    p = sub.add_parser("backfill", help="grant ping roles to recent authors of archived development channels")
    p.add_argument("--yes", action="store_true")
    p.add_argument("--days", type=int, default=90)
    p.add_argument("--only-user", metavar="ID", help="grant only to this one member (test mode)")
    p.add_argument("--channel", action="append", default=[], metavar="NAME_OR_ID",
                   help="limit to this archived channel; repeatable")
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
        desired = dc.load_desired(args.config)
        api = api or client(dc.token())
        server = Server(api, desired, sleep, clock)
        {"announce": cmd_announce, "notices": cmd_notices, "backfill": cmd_backfill}[args.command](args, server)
    except dc.ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
