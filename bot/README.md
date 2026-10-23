# OpenDrone Discord bot

A Cloudflare Worker that connects the Discord server to the OpenDrone-hw GitHub
organisation. It uses HTTP only (no gateway), so it receives commands, buttons
and modals but no message, reaction or member events.

```mermaid
flowchart LR
  D[Discord] -->|POST /interactions| W[Worker]
  G[GitHub App] -->|POST /github| W
  B[Browser] -->|GET /linked-roles, /early-bird| W
  C[Cron every 6 h] --> W
  W --> DA[Discord API]
  W --> GA[GitHub API]
  W --> DB[(D1)]
```

## GitHub activity

Default: only deploys post, one line each, only to the bot channel
`#git-feed`. No PR threads, PR cards, review cards, check cards, issue threads
or product-channel lines. Private repositories post nothing; a payload without
the `private` flag counts as private. The bot never posts to `#announcements`:
people write that channel.

`config/repos.json` sets the mode: top-level `"feed": "deploys"` (the default
for every repository) and an optional per-repository `"feed": "full"`. No
repository has the override now.

| Event | `feed: deploys` (default) | `feed: full` |
|---|---|---|
| Push to the default branch (PR merges included) | `#git-feed` line: repo, short sha, commit title, link | Line, except PR merges (the PR card already posted) |
| Release published (not a draft) | `#git-feed` line: repo, tag, release name, link | Release card in the product channel, line |
| PR opened, reopened, ready for review | Nothing | PR thread started if missing; card with the first paragraph of the description; starter line in the product channel; `#git-feed` line |
| New commits on a PR | Nothing | Push line in the PR thread |
| Review submitted | Nothing | Review card; `#git-feed` line for approved or changes requested |
| Checks finished | Nothing | Card for the head commit; default-branch failures in `#git-feed` |
| PR merged or closed | Nothing | Card, `#git-feed` line |
| Issue opened, reopened, comment, closed | Nothing | Issue thread, cards, comment lines, starter line, `#git-feed` line |
| `status-*` topic changed | Nothing | Lifecycle card, `#git-feed` line |
| KiCad collision guard | Comment on the PR on GitHub | Comment on GitHub and a warning in both threads |

A delivery that posts nothing still answers 202 and is recorded as skipped in
`github_deliveries`.

The rest of this section describes `feed: full`. A PR thread is named
`<repo> #<n>: <title>`. A PR that already has a
`Discussion:` line pointing at a thread in its product channel posts there
instead of starting one. An issue thread is named `<repo> issue #<n>: <title>`;
the link lives in D1 (`github_issues`), not in the issue. A comment on an open
issue without a thread starts one. Threads auto-archive after a week, the
longest Discord allows; the cron unarchives the thread of every issue that is
still open, without posting.

KiCad collision guard: when two open PRs in one repository change the same
`.kicad_pcb` or `.kicad_sch` file, the bot comments on the PR and posts a
warning in both threads. KiCad files cannot be merged.

Each delivery is processed once (D1 table `github_deliveries`); a redelivery
repeats only the failed steps. Every message is sent with
`allowed_mentions: {parse: []}`: the bot never pings.

### Kill switch

Posting from GitHub to Discord is off when either switch says off. Both are
read on every delivery; neither needs a code deploy. The secret works when D1
does not.

| Switch | Off | On again |
|---|---|---|
| `/posting state:off` in Discord (admins) | Stored in D1 `bot_settings` | `/posting state:on` |
| Worker secret `DISCORD_POSTING` (from `bot/`) | `printf off \| npx wrangler secret put DISCORD_POSTING` | `npx wrangler secret delete DISCORD_POSTING` |

`/posting` with no option shows both. While off, every delivery still gets
202 and is recorded as skipped in `github_deliveries`; a redelivery after
switching on posts it. The KiCad guard still comments on GitHub, issue states
stay current in D1, and the linked-role refresh keeps running. The cron does
not unarchive threads while off.

## Commands

| Command | Where | Who | Does |
|---|---|---|---|
| `/link pr:<url>` | Thread in the PR's product channel | Members | Links an existing thread to a PR |
| `/branch [repo]` | Thread in a product channel | Anyone | Fork and branch commands and the `Discussion:` line |
| `/editing repo:<name>` | Anywhere | Anyone | Open PRs that change KiCad files |
| `/verify` | Anywhere | Anyone | Link to the linked-roles page |
| `/promote` | Anywhere | Admin | New repository from `hardware-template`; off while `PROMOTE_ENABLED` is `"false"` |
| `/posting [state]` | Anywhere | Admin | Switches GitHub posting on or off, or shows the state |
| To GitHub issue | Message in a product thread | Members | Issue with a link back to the message |
| Approve build | Message | Reviewer, admin | Gives the author `Verified Builder` |

Members are holders of `Member` (given by the onboarding region answer),
`admin`, `developer`, `reviewer` or `beta tester`.

## Linked roles

`/verify` links a Discord account to a GitHub login. The Worker pushes:

| Key | Source | Role |
|---|---|---|
| `merged_prs` | GitHub search of merged PRs in the organisation | `Contributor` (at least 1) |
| `maintainer` | Member of the team `GITHUB_MAINTAINER_TEAM` (`core`) | `Maintainer` |
| `org_member` | Organisation membership | |
| `owner` | `users.owner` in D1; nothing writes it yet, so 0 | `Verified Owner` |

A merge or a team change refreshes that user at once; the cron refreshes the
rest daily.

## Early Bird

Every paid, not cancelled OpenDrone preorder placed before the preorder run
closes (2026-12-15) unlocks the `Early Bird` role and the private
`#early-birds` channel for one Discord account.

| Step | Where |
|---|---|
| Buyer proves the order: signed in on opendrone.be, or the link in the order confirmation mail | opendrone.be `/early-bird` (OpenDrone-Web) |
| Storefront checks the order in Shopify and signs a 10-minute claim token with `EARLY_BIRD_CLAIM_KEY` | opendrone.be |
| `GET /early-bird?t=<token>`: Discord authorization, scopes `identify guilds.join`, on the linked-roles callback | `src/linked-roles/early-bird.ts` |
| D1 `early_bird_claims`: the order is the primary key, so the first Discord account to claim it keeps it; that account may claim again | `migrations/0003_early_bird_claims.sql` |
| The bot adds a non-member to the server with the role, or adds the role to a member | Discord API |

Nothing is posted and no token is stored. To move an order to another
account, a person deletes its row in the Cloudflare D1 console
(`early_bird_claims`, by `order_name`) and the buyer claims again; the role
on the old account is removed by hand in Discord.

## Configuration

`config/repos.json` sets the GitHub feed mode (`feed`), maps each repository to
its product channel and names the channels and roles the bot uses; ids are resolved by name at runtime.
`tests/test_server_json.py` in the parent repository checks these names match
`server.json`.

| Var in `wrangler.toml` | Value |
|---|---|
| `GUILD_ID` | `1494019459822653512` |
| `APPLICATION_ID` | `1553826696673759344` |
| `GITHUB_MAINTAINER_TEAM` | `core` |
| `PROMOTE_ENABLED` | `"false"` |

| Secret (`npx wrangler secret put <NAME>`) | Source |
|---|---|
| `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Discord Developer Portal |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | GitHub App `opendrone-discord` |
| `GITHUB_WEBHOOK_SECRET` | The App's webhook secret |
| `SESSION_SECRET` | `openssl rand -base64 32`; rotating it unlinks every user |
| `DISCORD_POSTING` | Optional kill switch; unset means on, `off` stops GitHub posting |
| `EARLY_BIRD_CLAIM_KEY` | `openssl rand -base64 32`; the same value is the opendrone-web Worker secret of that name. Unset, `/early-bird` answers 503 |

The GitHub App has Metadata read, Pull requests and Issues read and write,
Checks and Contents read, organisation Members read, and no Administration.
It subscribes to pull request, review, check suite, issues, issue comment,
release, repository, push, organization and membership events.

The Developer Portal points the Interactions Endpoint at
`https://<worker>/interactions`, the Linked Roles Verification URL at
`https://<worker>/linked-roles`, and has the OAuth redirect
`https://<worker>/linked-roles/discord/callback`.

## Deploy

```sh
cd bot
npx wrangler d1 migrations apply opendrone-discord-bot --remote   # after a new migration
npx wrangler deploy
npm run register-commands -- --yes    # after a command changes
npm run register-metadata -- --yes    # after a linked-role key changes
```

Both register scripts print what they would send without `--yes`.

## Check

Node 23.6 or newer.

```sh
npm ci && npm test && npx tsc --noEmit
```

Tests replace `fetch` and fail on any network access.

## Code

| Path | Content |
|---|---|
| `src/index.ts`, `src/registry.ts` | Routes and the module contract |
| `src/commands/`, `src/github/`, `src/linked-roles/` | The three modules |
| `src/discord.ts`, `src/github.ts` | API clients |
| `config/repos.json` | Feed mode, repository to channel map, channel and role names |
| `src/linked-roles/early-bird.ts` | Early Bird claim |
| `migrations/` | D1 schema of the linked-role and Early Bird tables; the GitHub tables `github_deliveries`, `github_issues` and `bot_settings` are created on first use |
| `src/posting.ts` | Kill switch |

## Licence

MIT
