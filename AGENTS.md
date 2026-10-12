# OpenDrone Discord

Configuration as code for the OpenDrone Discord server (`server.json`, `discord_config.py`, `texts.py`) and a Cloudflare Worker bot (`bot/`).

Validate: `python3 -m unittest discover -s tests` and `cd bot && npm ci && npm test && npx tsc --noEmit`

## Boundaries

- `--yes` (`discord_config.py apply`, `restore`, every `texts.py ... --yes`) changes a live server with hundreds of members: run it only after the requester saw the dry run of that exact change.
- Layout and permissions change only in `server.json`; UI edits to managed channels are reverted by the next apply.
- Onboarding is the gate: never add a `Newbie` or `Member` overwrite to a channel, never delete those roles.
- Never delete channels, roles or messages from a script; retire channels through `archive` in `server.json`. Deleting in the Discord UI loses message history.
- `Early Bird` is assigned only by the claim flow (`bot/README.md` "Early Bird").
- Keep the `OpenDrone Support` bot permissions on `#web-support`, `#web-support-admin` and `#chatfpv`.
- No `wrangler deploy`, `wrangler secret put`, `register-commands --yes` or `register-metadata --yes` unless asked.
- A token seen in a chat, log or commit is leaked: have a person reset it in the Discord developer portal.
- Tests never touch the network; Python standard library only; bot has zero runtime dependencies.

## Pointers

- `README.md`, `bot/README.md`
- `python3 discord_config.py plan`: read-only diff against the live server
