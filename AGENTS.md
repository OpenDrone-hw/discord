# OpenDrone Discord

Configuration as code for the OpenDrone Discord server (`server.json`,
`discord_config.py`) and a Cloudflare Worker bot (`bot/`). Read `README.md`,
and `bot/README.md` for bot work.

## Validation

| Part | Command |
|---|---|
| Config tool | `python3 -m unittest discover -s tests` |
| Config tool against the live server (read-only) | `python3 discord_config.py plan` |
| Bot | `cd bot && npm ci && npm test && npx tsc --noEmit` |

Tests never touch the network. Keep it that way.

## Live server rules

| Rule | Detail |
|---|---|
| Apply only after the plan was seen | `apply --yes` and `restore --yes` change a live server with hundreds of members. Run them only after the person who asked has seen the `plan` (or restore dry run) output for that exact change |
| `server.json` is the only place layout and permissions change | Clicking a managed channel's permissions in the Discord UI is reverted by the next apply |
| No deletes | Never delete channels, roles, messages, commands or anything else from a script. Retire channels through `archive` in `server.json` |
| Do not touch `#web-support` or `#web-support-admin` | The storefront support bot owns them |
| No bot deploys or registrations unasked | `wrangler deploy`, `wrangler secret put`, `register-commands --yes` and `register-metadata --yes` need an explicit request |

## Tokens and secrets

| Rule | Detail |
|---|---|
| Never print, log, commit or echo a token | Refer to `OPENDRONE_DISCORD_BOT_TOKEN` (config tool) or the Worker secret names in `bot/README.md` |
| `snapshots/` stays out of Git | It holds member-visible server state |
| `bot/.dev.vars` stays out of Git | Local copies of Worker secrets |
| Bot text from GitHub or users | Send with `allowed_mentions: {parse: []}` (the client adds it by default) |

## Code

| Part | Rule |
|---|---|
| Python | Standard library only |
| Bot | TypeScript, zero runtime dependencies; dev dependencies only wrangler, typescript, vitest, @cloudflare/workers-types |
| Bot ids | Resolve channel, role and tag ids by name through `config/repos.json`; never hard-code them |
| Docs | Update `README.md` or `bot/README.md` in the same PR as the behaviour they describe |
