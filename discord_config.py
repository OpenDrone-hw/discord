#!/usr/bin/env python3
"""Plan and apply the OpenDrone Discord server layout from server.json.

Only channels listed in server.json are managed; everything else is reported
and left alone. Nothing is ever deleted. Every apply writes a snapshot first,
and `restore` puts the permission overwrites of managed channels back.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://discord.com/api/v10"
ROOT = Path(__file__).resolve().parent
SNAPSHOTS = ROOT / "snapshots"
TOKEN_VAR = "OPENDRONE_DISCORD_BOT_TOKEN"
CREDENTIALS = Path.home() / ".config/incutec/credentials.env"
AUDIT_REASON = "OpenDrone-hw/discord discord_config.py"

# Discord permission bit positions, D/topics/permissions.
PERMISSIONS = {
    name: 1 << bit
    for bit, name in enumerate(
        """CREATE_INSTANT_INVITE KICK_MEMBERS BAN_MEMBERS ADMINISTRATOR MANAGE_CHANNELS
        MANAGE_GUILD ADD_REACTIONS VIEW_AUDIT_LOG PRIORITY_SPEAKER STREAM VIEW_CHANNEL
        SEND_MESSAGES SEND_TTS_MESSAGES MANAGE_MESSAGES EMBED_LINKS ATTACH_FILES
        READ_MESSAGE_HISTORY MENTION_EVERYONE USE_EXTERNAL_EMOJIS VIEW_GUILD_INSIGHTS
        CONNECT SPEAK MUTE_MEMBERS DEAFEN_MEMBERS MOVE_MEMBERS USE_VAD CHANGE_NICKNAME
        MANAGE_NICKNAMES MANAGE_ROLES MANAGE_WEBHOOKS MANAGE_GUILD_EXPRESSIONS
        USE_APPLICATION_COMMANDS REQUEST_TO_SPEAK MANAGE_EVENTS MANAGE_THREADS
        CREATE_PUBLIC_THREADS CREATE_PRIVATE_THREADS USE_EXTERNAL_STICKERS
        SEND_MESSAGES_IN_THREADS USE_EMBEDDED_ACTIVITIES MODERATE_MEMBERS
        VIEW_CREATOR_MONETIZATION_ANALYTICS USE_SOUNDBOARD CREATE_GUILD_EXPRESSIONS
        CREATE_EVENTS USE_EXTERNAL_SOUNDS SEND_VOICE_MESSAGES _BIT47 SET_VOICE_CHANNEL_STATUS
        SEND_POLLS USE_EXTERNAL_APPS PIN_MESSAGES BYPASS_SLOWMODE""".split()
    )
}


class ConfigError(RuntimeError):
    pass


def bits(names: list[str]) -> int:
    value = 0
    for name in names:
        if name not in PERMISSIONS:
            raise ConfigError(f"unknown permission {name!r}")
        value |= PERMISSIONS[name]
    return value


def names(value: int) -> list[str]:
    known = [n for n, b in PERMISSIONS.items() if value & b]
    unknown = value & ~sum(PERMISSIONS.values())
    return known + ([f"0x{unknown:x}"] if unknown else [])


# --- desired state ---------------------------------------------------------


def load_desired(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("guild_id", "profiles", "categories"):
        if key not in data:
            raise ConfigError(f"{path.name}: missing {key!r}")
    return data


def expand_overwrites(spec: dict, profiles: dict, role_ids: dict, guild_id: str) -> dict:
    """Profile name or {role: {allow, deny}} -> {role_id: (allow, deny)}."""
    if isinstance(spec, str):
        if spec not in profiles:
            raise ConfigError(f"unknown profile {spec!r}")
        spec = profiles[spec]
    result = {}
    for role, rule in spec.items():
        rid = guild_id if role == "@everyone" else role_ids.get(role)
        if rid is None:
            raise ConfigError(f"unknown role {role!r}")
        extra = set(rule) - {"allow", "deny"}
        if extra:
            raise ConfigError(f"role {role!r}: unknown keys {sorted(extra)}")
        allow, deny = bits(rule.get("allow", [])), bits(rule.get("deny", []))
        if allow & deny:
            raise ConfigError(f"role {role!r}: {names(allow & deny)} both allowed and denied")
        result[rid] = (allow, deny)
    return result


def desired_channels(desired: dict, role_ids: dict) -> dict:
    """channel_id -> {"name", "overwrites", optional "topic"} for every managed channel."""
    gid, profiles = desired["guild_id"], desired["profiles"]
    out = {}
    for cat in desired["categories"]:
        cat_ow = expand_overwrites(cat["access"], profiles, role_ids, gid)
        out[cat["id"]] = {"name": cat["name"], "overwrites": cat_ow}
        for ch in cat.get("channels", []):
            ow = expand_overwrites(ch["access"], profiles, role_ids, gid) if "access" in ch else cat_ow
            entry = {"name": ch["name"], "overwrites": ow, "parent_id": cat["id"]}
            if "topic" in ch:
                entry["topic"] = ch["topic"]
            if ch["id"] in out:
                raise ConfigError(f"channel {ch['id']} listed twice")
            out[ch["id"]] = entry
    return out


# --- comparison ------------------------------------------------------------


def current_overwrites(channel: dict) -> dict:
    """Role overwrites only; member overwrites are never managed."""
    return {
        o["id"]: (int(o["allow"]), int(o["deny"]))
        for o in channel.get("permission_overwrites", [])
        if o["type"] == 0 and (int(o["allow"]) or int(o["deny"]))
    }


def plan(desired: dict, channels: list[dict], role_names: dict) -> tuple[list[dict], list[dict]]:
    """Return (changes, unmanaged channels)."""
    by_id = {c["id"]: c for c in channels}
    changes = []
    for cid, want in desired.items():
        have = by_id.get(cid)
        if have is None:
            raise ConfigError(f"channel {cid} ({want['name']}) does not exist; creating channels is not supported yet")
        diff = {}
        if have["name"] != want["name"]:
            diff["name"] = (have["name"], want["name"])
        if "topic" in want and (have.get("topic") or "") != want["topic"]:
            diff["topic"] = (have.get("topic") or "", want["topic"])
        if "parent_id" in want and have.get("parent_id") != want["parent_id"]:
            diff["parent_id"] = (have.get("parent_id"), want["parent_id"])
        cur, new = current_overwrites(have), want["overwrites"]
        ow_diff = {}
        for rid in sorted(set(cur) | set(new)):
            a, b = cur.get(rid, (0, 0)), new.get(rid, (0, 0))
            if a != b:
                ow_diff[role_names.get(rid, rid)] = {
                    "allow+": names(b[0] & ~a[0]), "allow-": names(a[0] & ~b[0]),
                    "deny+": names(b[1] & ~a[1]), "deny-": names(a[1] & ~b[1]),
                }
        if ow_diff:
            diff["overwrites"] = ow_diff
        if diff:
            changes.append({"id": cid, "name": have["name"], "diff": diff, "want": want})
    unmanaged = [c for c in channels if c["id"] not in desired]
    return changes, unmanaged


def patch_body(change: dict, channel: dict) -> dict:
    body = {}
    for key in ("name", "topic", "parent_id"):
        if key in change["diff"]:
            body[key] = change["want"][key]
    if "overwrites" in change["diff"]:
        members = [o for o in channel.get("permission_overwrites", []) if o["type"] == 1]
        body["permission_overwrites"] = members + [
            {"id": rid, "type": 0, "allow": str(a), "deny": str(d)}
            for rid, (a, d) in change["want"]["overwrites"].items()
        ]
    return body


# --- Discord REST ----------------------------------------------------------


def token() -> str:
    value = os.environ.get(TOKEN_VAR)
    if not value and CREDENTIALS.exists():
        for line in CREDENTIALS.read_text(encoding="utf-8").splitlines():
            if line.startswith(TOKEN_VAR + "="):
                value = line.split("=", 1)[1].strip().strip('"')
    if not value:
        raise ConfigError(f"{TOKEN_VAR} is not set (environment or {CREDENTIALS})")
    return value


def ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if not ctx.get_ca_certs() and Path("/etc/ssl/cert.pem").exists():
        ctx.load_verify_locations("/etc/ssl/cert.pem")  # python.org builds on macOS ship no CA store
    return ctx


class Discord:
    def __init__(self, tok: str):
        self.headers = {
            "Authorization": f"Bot {tok}",
            "User-Agent": "DiscordBot (https://github.com/OpenDrone-hw/discord, 1)",
            "Content-Type": "application/json",
            "X-Audit-Log-Reason": AUDIT_REASON,
        }
        self.ctx = ssl_context()

    def request(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        for _ in range(5):
            req = urllib.request.Request(API + path, data=data, method=method, headers=self.headers)
            try:
                with urllib.request.urlopen(req, context=self.ctx, timeout=30) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode(errors="replace")
                if exc.code == 429:
                    time.sleep(float(json.loads(detail).get("retry_after", 1)) + 0.1)
                    continue
                raise ConfigError(f"{method} {path}: HTTP {exc.code} {detail[:300]}") from exc
        raise ConfigError(f"{method} {path}: still rate limited after 5 attempts")


def fetch(api: Discord, gid: str) -> dict:
    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "guild_id": gid,
        "channels": api.request("GET", f"/guilds/{gid}/channels"),
        "roles": api.request("GET", f"/guilds/{gid}/roles"),
        "onboarding": api.request("GET", f"/guilds/{gid}/onboarding"),
    }


def save_snapshot(state: dict, label: str) -> Path:
    SNAPSHOTS.mkdir(exist_ok=True)
    path = SNAPSHOTS / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{label}.json"
    path.write_text(json.dumps(state, indent=1), encoding="utf-8")
    return path


# --- commands --------------------------------------------------------------


def print_plan(changes: list[dict], unmanaged: list[dict]) -> None:
    if not changes:
        print("No changes: managed channels match server.json.")
    for ch in changes:
        print(f"\n#{ch['name']} ({ch['id']})")
        for key, val in ch["diff"].items():
            if key != "overwrites":
                print(f"  {key}: {val[0]!r} -> {val[1]!r}")
                continue
            for role, d in val.items():
                parts = [f"{k} {', '.join(v)}" for k, v in d.items() if v]
                print(f"  {role}: " + "; ".join(parts))
    print(f"\n{len(changes)} channel(s) to change, {len(unmanaged)} unmanaged left alone: "
          + ", ".join(sorted(c["name"] for c in unmanaged)))


def build(desired_path: Path, api: Discord):
    desired = load_desired(desired_path)
    state = fetch(api, desired["guild_id"])
    role_ids = {r["name"]: r["id"] for r in state["roles"]}
    if len(role_ids) != len(state["roles"]):
        raise ConfigError("duplicate role names on the server; overwrites are resolved by name")
    role_names = {r["id"]: r["name"] for r in state["roles"]}
    want = desired_channels(desired, role_ids)
    changes, unmanaged = plan(want, state["channels"], role_names)
    return desired, state, changes, unmanaged


def cmd_audit(args, api):
    desired = load_desired(args.config)
    path = save_snapshot(fetch(api, desired["guild_id"]), "audit")
    print(f"snapshot: {path.relative_to(ROOT)}")


def cmd_plan(args, api):
    _, _, changes, unmanaged = build(args.config, api)
    print_plan(changes, unmanaged)


def cmd_apply(args, api):
    desired, state, changes, unmanaged = build(args.config, api)
    print_plan(changes, unmanaged)
    if not changes:
        return
    if not args.yes:
        print("\nDry run. Re-run with --yes to apply.")
        return
    snap = save_snapshot(state, "before-apply")
    print(f"\nsnapshot: {snap.relative_to(ROOT)}")
    by_id = {c["id"]: c for c in state["channels"]}
    for ch in changes:
        api.request("PATCH", f"/channels/{ch['id']}", patch_body(ch, by_id[ch["id"]]))
        print(f"applied #{ch['name']}")
    _, _, left, _ = build(args.config, api)
    if left:
        print_plan(left, [])
        raise ConfigError("read-back still differs from server.json")
    print("read-back: managed channels match server.json")


def cmd_restore(args, api):
    snap = json.loads(args.snapshot.read_text(encoding="utf-8"))
    desired = load_desired(args.config)
    role_ids = {r["name"]: r["id"] for r in api.request("GET", f"/guilds/{desired['guild_id']}/roles")}
    managed = desired_channels(desired, role_ids)
    old = {c["id"]: c for c in snap["channels"] if c["id"] in managed}
    for cid, ch in old.items():
        print(f"restore #{ch['name']}: {len(ch['permission_overwrites'])} overwrite(s)")
    if not args.yes:
        print("\nDry run. Re-run with --yes to restore.")
        return
    for cid, ch in old.items():
        api.request("PATCH", f"/channels/{cid}", {"permission_overwrites": ch["permission_overwrites"]})
    print(f"restored {len(old)} channel(s) from {args.snapshot.name}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=ROOT / "server.json")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("audit", help="save a snapshot of the live server under snapshots/")
    sub.add_parser("plan", help="show what apply would change")
    p = sub.add_parser("apply", help="dry run by default; --yes applies and reads back")
    p.add_argument("--yes", action="store_true")
    p = sub.add_parser("restore", help="put managed channels' overwrites back from a snapshot")
    p.add_argument("snapshot", type=Path)
    p.add_argument("--yes", action="store_true")
    args = parser.parse_args(argv)
    try:
        api = Discord(token())
        {"audit": cmd_audit, "plan": cmd_plan, "apply": cmd_apply, "restore": cmd_restore}[args.command](args, api)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
