# OpenDrone Discord bot

A Cloudflare Worker that connects the OpenDrone Discord server to the
OpenDrone-hw GitHub organisation. It talks to Discord over HTTP only (no
gateway connection), so it receives interactions (commands, buttons, modals)
but no message, reaction or member events.

```mermaid
flowchart LR
  D[Discord] -->|POST /interactions, Ed25519| W[Worker src/index.ts]
  G[GitHub App] -->|POST /github, HMAC-SHA256| W
  B[Member browser] -->|GET /linked-roles/*| W
  C[Cron every 6 h] -->|scheduled| W
  W --> R[Registry src/registry.ts]
  R --> M1[src/commands]
  R --> M2[src/github]
  R --> M3[src/linked-roles]
  M1 & M2 & M3 -->|src/discord.ts| DA[Discord API]
  M2 & M3 -->|src/github.ts, App installation| GA[GitHub API]
  M2 --> DB[(D1)]
  M3 --> DB
```

## Endpoints

| Route | Handler | Answer |
|---|---|---|
| `POST /interactions` | `src/interactions.ts` | 401 on a bad or missing Ed25519 signature or an interaction older than 300 s; PING gets PONG; any guild other than `GUILD_ID` gets an ephemeral refusal |
| `POST /github` | `src/webhooks.ts` | 401 on a bad `X-Hub-Signature-256`; `ping` gets 200; otherwise 202 and the matching handlers run in `ctx.waitUntil` |
| `GET /linked-roles` | `src/linked-roles/routes.ts` | 302 to Discord OAuth (`identify role_connections.write`, `prompt=consent`) |
| `GET /linked-roles/discord/callback` | same | Stores the sealed Discord refresh token, 200 account check page: names the Discord account, links to GitHub OAuth and to a restart |
| `GET /linked-roles/github/callback` | same | Stores the login and sealed GitHub refresh token, PUTs the role connection, 200 result page |
| `scheduled()` | every module's `scheduled` | Cron `17 */6 * * *` (`wrangler.toml`) |

Any other path is 404; a known path with the wrong method is 405.

## What each module does

| Module | Does |
|---|---|
| `src/commands/` | Slash and context-menu commands (see [Commands](#commands)); Discord shows them only after `register-commands --yes` |
| `src/github/` | Posts GitHub activity into Discord and runs the KiCad collision guard (tables below) |
| `src/linked-roles/` | Discord + GitHub OAuth, role connection metadata, D1 storage of sealed refresh tokens, cron refresh |

### GitHub events

| Event.action | Thread of the PR in its product channel | `#git-feed` | `#announcements` |
|---|---|---|---|
| `pull_request.opened`, `reopened`, `ready_for_review` | Started if missing, card with the first paragraph of the description | One line | No |
| `pull_request.synchronize` | Started if missing, push line (with the first paragraph of the description when this event started the thread) | No | No |
| `pull_request.closed` | Card if linked (merged or closed) | One line | No |
| `pull_request_review.submitted` | Started if missing, review card | Approved or changes requested | No |
| `check_suite.completed` | Card if linked, only for the PR head commit | Default-branch failures only | No |
| `release.published` | No | One line | Release card with up to 10 asset links |
| `repository.edited` (`changes.topics`) | No | One line | When the `status-*` topic changes |
| `push` | No | Default branch only, not PR merges | No |
| `organization.member_added`, `member_removed` | No | No | No |
| `membership.added`, `removed` (team) | No | No | No |

`pull_request.closed` with `merged: true`, `organization.member_added` and
`member_removed`, and team `membership.added` and `removed` also refresh the
affected user's linked-role metadata (see [Linked-role metadata](#linked-role-metadata)).

Private repositories post nothing to Discord; the collision guard still comments
on their pull requests.

### PR to thread link

```mermaid
flowchart TD
  E[PR event] --> L{"Discussion: line in the PR body?"}
  L -->|yes| V{Thread whose parent is this repo's product channel?}
  V -->|yes| P[Post in that thread]
  V -->|no| X[Log, post nothing, start nothing]
  L -->|no| C{PR open, and event is not closed or check_suite?}
  C -->|yes| M[One-line starter message in the product channel] --> N[Start a public thread from it] --> A[Append Discussion: line to PR body] --> P
  C -->|no| S[Skip thread]
```

| Step | Discord call | Detail |
|---|---|---|
| Starter | `POST /channels/{channel}/messages` | "Pull request **OpenRX** #12 by alice: title" linking the PR; "Draft pull request" for a draft |
| Thread | `POST /channels/{channel}/messages/{starter}/threads` | Name `<repo> #<n>: <title>` cut to 100 characters (for example `OpenRX #12: Move the antenna`), `auto_archive_duration` 10080 (a week). The thread id is the starter's id; a retry that finds the thread already started (Discord code 160004) uses it |
| Link | GitHub `PATCH` of the PR body | Read again right before writing so an edit made meanwhile is kept |
| Card | `POST /channels/{thread}/messages` | Title, actor and the first paragraph of the PR description as plain text: HTML comments, images, headings, tables, rules and code blocks skipped, at most 300 characters ending in "..." when cut. The "Open on GitHub" button carries the rest |

The line is `Discussion: https://discord.com/channels/<guild>/<thread>`. It is
the only record of the link; nothing about it is stored in D1. There are no
tags: a lifecycle change (`status-*` topic) is announced in `#git-feed` and
`#announcements` only.

### KiCad collision guard

On `pull_request` opened, reopened, ready_for_review and synchronize, the PR's
`.kicad_pcb` and `.kicad_sch` files are compared with up to 25 other open PRs in
the same repository. For each overlapping pair the bot posts one PR comment on
the triggering PR and a warning card in both PRs' threads. A hidden marker in
the comment records the pair and files, so a pair is warned again only when a
new file overlaps.

### Idempotency

Every visible step (starter message, thread, card, feed line) runs once per
`X-GitHub-Delivery` through the D1 table `github_deliveries`, created on first
use and pruned after 7 days by the cron. A redelivery repeats only the steps
that failed.

### Linked-role metadata

| Key | Type | Source |
|---|---|---|
| `merged_prs` | Integer, greater than or equal | GitHub search `is:pr is:merged org:OpenDrone-hw author:<login>` |
| `org_member` | Boolean | `GET /orgs/OpenDrone-hw/members/<login>` |
| `maintainer` | Boolean | Active member of the team `GITHUB_MAINTAINER_TEAM` (`core` in `wrangler.toml`; `maintainers` when unset) |
| `owner` | Boolean | `users.owner` in D1. Owner means any paid order on opendrone.be, preorders included; the storefront is to fill it, and nothing in this repository writes it, so it is 0 |

The cron refreshes 6 users per run whose last refresh is older than 24 h, oldest
first (4 runs a day, at most 24 users a day). A per-user lease in D1 serialises
overlapping refreshes of one user.

Discord re-evaluates linked roles only when the bot pushes new metadata, so
these webhook events push it at once for the GitHub login they concern
(`src/github/linked-roles.ts`, calling `refreshLinkedUser`):

| Event.action | Login refreshed |
|---|---|
| `pull_request.closed` with `merged: true` | The PR author |
| `organization.member_added`, `member_removed` | `membership.user` |
| `membership.added`, `removed`, scope `team` | `member` |

Only events of the `config/repos.json` organisation count, and bot logins such
as `dependabot[bot]` are skipped. The refresh runs as its own handler in
`ctx.waitUntil`, next to the posting handlers, so the 202 reply and the Discord
cards never wait for it. A failed refresh is logged and the webhook carries on;
a refresh still running after 25 s is logged as unfinished, before Cloudflare
cancels it at 30 s. A login nobody linked is a D1 lookup and nothing else. A
user whose webhook refresh failed is refreshed by the cron once their last
refresh is older than 24 h.

`merged_prs` comes from GitHub search, which indexes a merge asynchronously and
can still return the pre-merge count when the refresh runs a second after the
webhook. The merge refresh therefore passes a lower bound of 1
(`refreshLinkedUser(services, login, options, { minMergedPrs: 1 })`): the
pushed value is `max(search count, 1)`, so a first merged pull request moves
`merged_prs` from 0 to 1 at once. The bound applies only while the Discord user
is still linked to that login; after a GitHub unlink or rename the search count
stands. For an author who already had merged PRs the count can stay one short
until their next refresh.

### Which Discord account gets linked

The Linked Roles buttons in the Discord app (connect, manage account) and
`/verify` open the verification URL in the browser. Discord OAuth authorises
whichever account is signed in to discord.com in that browser, which can
differ from the account in the app. The flow never sees the app's account, so:

| Step | Guard |
|---|---|
| Discord authorize | `prompt=consent` always shows Discord's screen, which names the signed-in account and offers "Not you?" |
| Discord callback | Account check page: "signed in to Discord as Display (@username)", then "continue with GitHub" or "start again" |
| GitHub callback | Result page names the Discord account again |

A member who linked the wrong account runs the flow again with the right one:
the GitHub login moves to the Discord account that linked it last, and the
other account's metadata is emptied by the next cron run.

## Behaviour every module inherits

| Rule | Where |
|---|---|
| Every message the bot sends carries `allowed_mentions: {parse: []}` unless the caller sets `allowed_mentions` explicitly | `src/discord.ts`, `src/interactions.ts` |
| On 429 the client waits `retry_after` and retries (3 times); rate-limit waits share a 5 s budget per call, beyond it the call throws `RateLimitError` | `src/discord.ts` |
| Tokens in `/webhooks/{id}/{token}` and `/interactions/{id}/{token}` paths are redacted from errors | `src/discord.ts` |
| Mutating Discord calls carry the audit log reason `OpenDrone-hw/discord bot` unless given another | `src/discord.ts` |
| A failing GitHub handler is logged and does not stop the others | `src/webhooks.ts` |
| `defer()` work and GitHub handlers run in `ctx.waitUntil`, which Cloudflare cancels 30 s after the response | `src/interactions.ts`, `src/webhooks.ts` |
| Channel and role ids are resolved by name at runtime; no id is hard-coded | `src/config.ts` |
| A module conflict (same command, custom_id prefix or route) fails at startup | `src/registry.ts` |

## Commands

All are guild-only. Role checks run in the Worker; `default_member_permissions`
only decides who sees a command until an override is added in Server
Settings, Integrations, OpenDrone Dev.

| Word in the table | Roles (`config/repos.json` keys), or Administrator for `admin` |
|---|---|
| members | `member`, `admin`, `developer`, `reviewer`, `betaTester`. `Member` comes from the onboarding region answer, so every member who finished onboarding counts |
| staff | `admin`, `developer` |

| Command | Where | Who | What it does |
|---|---|---|---|
| `/link pr:<url>` | thread in the text channel the PR's repository maps to | members; private repos: refused | Writes `Discussion: <thread url>` into the PR description; a repository of another channel is refused before any GitHub call. Replaces an existing line only when it points at a thread the bot started or at a deleted thread, and leaves a "moved to" note in the replaced thread |
| `/branch [repo]` | thread in a product channel | anyone who can use it | Fork and branch commands, and the `Discussion:` line to put in the PR description. `repo` accepts and autocompletes only repositories mapped to the thread's channel (the ones the thread name mentions first); without it, a pull request thread uses the repository its name starts with (`<repo> #<n>: ...`), another thread a name that names exactly one of them, and a channel with one repository decides. The branch name comes from the thread name, without the `<repo> #<n>:` prefix |
| `/editing repo:<name>` | anywhere | anyone; private repos: staff | Open PRs that change `.kicad_pcb` or `.kicad_sch` files |
| `/verify` | anywhere | anyone who can use it | Link to the Linked Roles verification page |
| `/promote name summary [private]` | anywhere | admin | Creates a repository from `hardware-template` with topic `status-planned`. Refuses while `PROMOTE_ENABLED` is `"false"` |
| To GitHub issue | message in a thread of a product channel | members; private repos: staff | Modal offering the channel's repositories (a pull request thread's own repository, or the one the thread name mentions, preselected), then an issue with a link back to the message |
| Approve build | message | reviewer or admin | Grants Verified Builder to the message author |

Approve build and `/promote` are visible to Administrators only until an
override is added.

The commands find the repository from the thread's parent channel: a thread
whose parent is not a text channel named in `config/repos.json` (a forum, the
retired development forums included, or any other channel) is refused. The
GitHub module follows a `Discussion:` line only to a thread in the
repository's own product channel (`linkState` in
`src/github/thread-link.ts`), so `/link` and `/branch` refuse any other
repository instead of writing or handing out a line it would ignore. A thread
name mentions a repository when the name appears as a whole word, case
insensitive: "OpenFC-Lite: move the USB connector" names OpenFC-Lite, not
OpenFC.

## `config/repos.json`

| Key | Meaning |
|---|---|
| `org` | GitHub organisation; repositories outside it are ignored |
| `channels` | `gitFeed`, `announcements`, `modLog`: channel names |
| `roles` | Role names by key (`admin`, `reviewer`, `verifiedBuilder`, ...) |
| `lifecycle` | `status-*` repository topic to the name shown in `#announcements` and `#git-feed` (and in the pinned hubs, `migrate.py hubs`) |
| `repos` | Repository name to `{channel}`: the product text channel its pull request threads start in. The product channels are the distinct `channel` values |

Loading fails on an unknown key (the old `forums`, `lifecycleTags` and `tag`
included), a repository listed twice, a channel name Discord would change, or a
product channel that is one of the `channels` above.

| Product channel | Repositories |
|---|---|
| fc | OpenFC-Lite, OpenFC-Lite-Mini, OpenFC |
| aio | OpenAIO, OpenAIO-Whoop |
| esc | OpenESC-20x20, OpenESC-30x30 |
| rx | OpenRX, OpenRX-Lite, OpenRX-Lite-UFL, OpenRX-Mono, OpenRX-Gemini |
| vtx | OpenVTX |
| remote-id | OpenRemoteID |
| gps | OpenGPS |
| frame | OpenFrame-3F, OpenFrame-5F |
| charger | Charger |
| kicad-library | KiCad-Library, hardware-template, OpenDrone-Fixtures |
| fc-betaflight | betaflight |
| esc-am32 | AM32 |
| rx-expresslrs | ExpressLRS |
| opendrone-web | OpenDrone-Web, OpenDrone-Brand, .github, discord |

### Server prerequisites

The names in `config/repos.json` must exist on the server. They come from two
places:

| Names | Source |
|---|---|
| Roles `admin`, `developer`, `beta tester`, `reviewer`, `Member`; channel `announcements` | Exist on the live server; `server.json` does not create them (`announcements` is matched by id) |
| Channels `git-feed`, `mod-log`; the product text channels (listed by id in `server.json`; `kicad-library` is created by it); roles `Verified Owner`, `Verified Builder`, `Contributor`, `Maintainer` | Created or managed by the repository's `server.json` |

`tests/test_server_json.py` checks that every name exists after
`discord_config.py apply` (created by `server.json` or already live) and fails
when the two files drift apart. Until `apply --yes` has run, the names
`server.json` creates are missing:

| Missing on the server | Effect |
|---|---|
| A channel in `channels` | The message is logged and dropped |
| A product channel | Thread creation for that repository fails and is logged; the `#git-feed` line is still posted |

## Layout

| Path | Content |
|---|---|
| `src/index.ts` | Entry point and route table |
| `src/registry.ts` | The `BotModule` contract, dispatch rules and time budgets |
| `src/interactions.ts` | `POST /interactions` and the reply helpers `messageResponse`, `ephemeral`, `defer` |
| `src/webhooks.ts` | `POST /github` |
| `src/verify.ts` | Ed25519 and HMAC-SHA256 checks |
| `src/discord.ts` | Discord REST client |
| `src/github.ts` | GitHub App client: RS256 JWT via WebCrypto, installation token cache |
| `src/config.ts` | `config/repos.json` validation, `findRepo`, `Directory` (name to id, cached per isolate) |
| `src/services.ts` | Per-request bundle of env, clients and directory |
| `src/commands/` | Commands; table at the top of `src/commands/index.ts` |
| `src/github/` | Webhook handlers; file table at the top of `src/github/index.ts` |
| `src/linked-roles/` | Linked roles; file table at the top of `src/linked-roles/index.ts` |
| `config/repos.json` | Repository to product channel, channel, role and lifecycle names |
| `migrations/` | D1 schema for `users` |
| `scripts/` | `register-commands.ts`, `register-metadata.ts` |
| `test/` | vitest suites, offline |

## Check

Node 23.6 or newer (the scripts run TypeScript directly).

```sh
cd bot
npm ci
npm test            # vitest run
npx tsc --noEmit
```

Tests replace `fetch` and fail on any network access.

## Setup

Replace `<worker>` below with the Worker's URL, for example
`opendrone-discord-bot.<account>.workers.dev`. Every step is manual.

```mermaid
flowchart LR
  A[1 D1] --> B[2 GitHub App] --> C[3 Secrets] --> D[4 Deploy] --> E[5 Developer Portal] --> F[6 Register metadata] --> G[7 Attach linked roles]
```

### 1. D1 database

```sh
npx wrangler d1 create opendrone-discord-bot
# put the printed database_id into wrangler.toml
npx wrangler d1 migrations apply opendrone-discord-bot --remote
```

### 2. GitHub App

GitHub: organisation OpenDrone-hw, Settings, Developer settings, GitHub Apps,
New GitHub App.

| Setting | Value |
|---|---|
| Callback URL | `https://<worker>/linked-roles/github/callback` |
| Expire user authorization tokens | On (issues refresh tokens) |
| Request user authorization (OAuth) during installation | Off |
| Webhook | Active, URL `https://<worker>/github`, secret = `GITHUB_WEBHOOK_SECRET` |
| Where can this GitHub App be installed | Only on this account |

These are the permissions and events the merged code uses. Grant nothing more.

| Repository permission | Access | Used for |
|---|---|---|
| Metadata | Read | Required; the repository event; the `private` flag read by `/editing` and "To GitHub issue" |
| Pull requests | Read and write | Read PRs and their files, list open PRs, append the `Discussion:` line to a PR body (webhooks and `/link`), post the collision comment (issue comments API on a PR), `/editing` |
| Issues | Read and write | "To GitHub issue" creates the issue |
| Checks | Read | `check_suite` events |
| Contents | Read | `push` and `release` events |
| Administration | No access | Only `/promote` needs it (see below). Without it the App cannot create, delete, rename or transfer repositories or change settings and branch protection |

| Organization permission | Access | Used for |
|---|---|---|
| Members | Read | `org_member` and `maintainer` linked-role metadata; required to subscribe to the Organization and Membership events |

| Webhook event | Actions handled |
|---|---|
| Pull request | opened, reopened, ready_for_review, synchronize, closed (a merge also refreshes the author's linked roles) |
| Pull request review | submitted |
| Check suite | completed |
| Release | published |
| Repository | edited (only `changes.topics` is read) |
| Push | every push; only the default branch is posted |
| Organization | member_added, member_removed (linked-role refresh) |
| Membership | added, removed (team membership; linked-role refresh) |

`/promote` is implemented but disabled: `PROMOTE_ENABLED` is `"false"` in
`wrangler.toml`, and the command then refuses before any GitHub call. Enabling
it needs `PROMOTE_ENABLED = "true"` and "Administration: Read and write" on the
App, which is why Administration stays at No access until then. Setting the
`status-planned` topic also needs the new repository to be inside the App
installation, so install the App on all repositories of the organisation.

After creating it: generate a private key and a client secret, then install the
App on OpenDrone-hw. The private key can stay in the PKCS#1 form GitHub issues;
the Worker converts it.

### Discord permissions of the bot role

The `OpenDrone Dev` role holds Administrator and sits at the top while the
layout is built. Without Administrator the Worker needs:

| Permission | Where | Used by |
|---|---|---|
| View Channels, Send Messages, Create Public Threads, Send Messages in Threads | Product text channels (the `open` profile grants these to `@everyone`) | Starter messages, PR threads and cards, collision warnings |
| View Channels, Send Messages | `#git-feed`, `#announcements` (the `readonly` profile allows the bot role explicitly) | Feed lines, release and lifecycle cards |
| Manage Roles, role above Verified Builder | Server | Approve build |

`discord_config.py` and `migrate.py` use the same application's token and need
more (Manage Channels, Manage Roles, Manage Server, Pin Messages to pin the
rules and hubs and unpin its notices, View Audit Log for firmware-roles), so the role keeps Administrator while the
layout is applied and migrated.

### 3. Secrets

`npx wrangler secret put <NAME>` for each; it prompts for the value.

| Name | Source |
|---|---|
| `DISCORD_PUBLIC_KEY` | Developer Portal, General Information, Public Key |
| `DISCORD_BOT_TOKEN` | Developer Portal, Bot, token |
| `DISCORD_CLIENT_ID` | Developer Portal, OAuth2, Client ID |
| `DISCORD_CLIENT_SECRET` | Developer Portal, OAuth2, Client Secret |
| `GITHUB_APP_ID` | GitHub App page, App ID |
| `GITHUB_APP_PRIVATE_KEY` | The downloaded `.pem`: `npx wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem` |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret chosen in step 2 |
| `GITHUB_OAUTH_CLIENT_ID` | GitHub App page, Client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | GitHub App page, generated client secret |
| `SESSION_SECRET` | `openssl rand -base64 32`; seals refresh tokens and the session cookie. Rotating it makes stored tokens unreadable: those users must link again |

| Var (`wrangler.toml`) | Value |
|---|---|
| `GUILD_ID` | `1494019459822653512` |
| `APPLICATION_ID` | `1553826696673759344` |
| `PROMOTE_ENABLED` | `"false"`; `/promote` refuses unless it is `"true"` |
| `GITHUB_MAINTAINER_TEAM` | `core`, the organisation team that holds the maintainers (the other team, `engineering`, does not count). Team slug for `maintainer`; unset means `maintainers`, which does not exist in the organisation. The team must exist, otherwise `maintainer` is 0 for everyone |

For `npm run dev`, copy `.dev.vars.example` to `.dev.vars` (git-ignored).

### 4. Deploy

```sh
npx wrangler deploy
```

### 5. Discord Developer Portal

Application `OpenDrone Dev` (1553826696673759344).

| Page | Field | Value |
|---|---|---|
| General Information | Interactions Endpoint URL | `https://<worker>/interactions` |
| General Information | Linked Roles Verification URL | `https://<worker>/linked-roles` |
| OAuth2 | Redirects | `https://<worker>/linked-roles/discord/callback` |

Discord checks the endpoint on save with a PING and a request with a bad
signature, so the Worker must be deployed with `DISCORD_PUBLIC_KEY` first.
With an endpoint URL set, all of this application's interactions go to the
Worker; a gateway process on the same application stops receiving them.

### 6. Register metadata (and commands)

Both scripts print what they would send and stop; `--yes` sends it. Each
replaces the whole list on Discord, so an empty list is refused.
`register-metadata` also refuses a schema Discord would reject, and
`--dry-run` wins over `--yes`. They read `APPLICATION_ID` and `GUILD_ID` from
the environment or `wrangler.toml`, and the token from `DISCORD_BOT_TOKEN`,
else `OPENDRONE_DISCORD_BOT_TOKEN` from the environment or
`~/.config/incutec/credentials.env`. The token is never printed.

`register-commands -- --dry-run` prints only the JSON body and cannot be
combined with `--yes`. A command without `default_member_permissions` or the
guild-only context is refused.

```sh
npm run register-metadata
npm run register-metadata -- --yes
npm run register-commands
npm run register-commands -- --dry-run
npm run register-commands -- --yes
```

### 7. Attach linked roles

Discord: Server Settings, Roles, the role, Links, add `OpenDrone Dev` and set
its requirements. This has no API.

## Not implemented

| Item | State in this branch |
|---|---|
| `owner` metadata | Always 0: nothing writes `users.owner` |
| `status` webhook | No handler; do not subscribe |
| Message, reaction and member events | Need a gateway connection; the Worker has none |
| Work longer than 30 s | No Cloudflare Queue is configured; only the cron (15 min per invocation) runs longer |
| `channels.modLog` in `config/repos.json` | Validated and resolvable, used by no handler; `roles` is read by the commands' role checks |

## Adding to a module

Each module's `index.ts` exports one `BotModule`; the contract, the dispatch
table and the time budgets are documented in `src/registry.ts`. `src/commands/`
is a complete example of commands, autocomplete and a modal component.

## Licence

MIT, as the rest of the repository.
