# OpenDrone Discord

Configuration as code for the OpenDrone Discord server (`server.json`,
`discord_config.py`, `migrate.py`) and a Cloudflare Worker bot (`bot/`). Read
`README.md`, and `bot/README.md` for bot work.

## Validation

| Part | Command |
|---|---|
| Config tool and migration | `python3 -m unittest discover -s tests` |
| Bot | `cd bot && npm ci && npm test && npx tsc --noEmit` |
| Against the live server (read-only) | `python3 discord_config.py plan` |

Tests never touch the network. Keep it that way: `migrate.py hubs` reads GitHub
through `gh api`, and tests pass a fake fetcher instead.

## Live server rules

| Rule | Detail |
|---|---|
| `--yes` only after the dry run was seen | `discord_config.py apply --yes`, `restore --yes` and every `migrate.py ... --yes` change a live server with hundreds of members. Run them only after the person who asked has seen the dry-run output for that exact change |
| `server.json` is the only place layout and permissions change | Clicking a managed channel's permissions in the Discord UI is reverted by the next apply |
| Gating model A | Onboarding is the gate. Never add a `Newbie` or `Member` overwrite to a channel or profile, and never delete those roles |
| No deletes | Never delete channels, roles, messages, commands or anything else from a script. Retire a channel through `archive` in `server.json`, or drop it from `server.json` and leave the delete to a person in the Discord UI. `migrate.py`'s client allows DELETE only to unpin a message and to take a role off a member; do not widen `UNDO_PATHS` |
| Firmware team roles | `Betaflight`, `AM32` and `ExpressLRS` are maintainer roles in `guard.unassignable_roles`; onboarding and scripts give the `* user` roles |
| Do not touch `#web-support` or `#web-support-admin` | The storefront support bot owns them; they are `guard.protected_channels` |
| No bot deploys or registrations unasked | `wrangler deploy`, `wrangler secret put`, `register-commands --yes` and `register-metadata --yes` need an explicit request |

## Tokens and secrets

| Rule | Detail |
|---|---|
| Never print, log, commit or echo a token | Refer to `OPENDRONE_DISCORD_BOT_TOKEN` (config tool, migration) or the Worker secret names in `bot/README.md` |
| `snapshots/` stays out of Git | It holds member-visible server state |
| `bot/.dev.vars` stays out of Git | Local copies of Worker secrets |
| Bot text from GitHub or users | Send with `allowed_mentions: {parse: []}` (the client adds it by default) |
| `migrate.py` output | Counts only; never add user ids or names to the output of any subcommand |

## Code

| Part | Rule |
|---|---|
| Python | Standard library only |
| Bot | TypeScript, zero runtime dependencies; dev dependencies only wrangler, typescript, vitest, @cloudflare/workers-types |
| Bot ids | Resolve channel and role ids by name through `config/repos.json`; never hard-code them |
| Product channels | One text channel per product; `config/repos.json` maps each repository to one, and pull request threads start there. No development forums, no lifecycle tags |
| Names shared by `server.json` and `config/repos.json` | Change both in one PR; `tests/test_server_json.py` checks they match |
| Docs | Update `README.md` or `bot/README.md` in the same PR as the behaviour they describe |
