# OpenDrone Discord

Configuration as code for the [OpenDrone Discord server](https://discord.gg/v3sWmTcx3R).

| Part | What it is | Guide |
|---|---|---|
| `server.json` + `discord_config.py` | Channels, categories, forums, roles, order, archive, onboarding, welcome screen, AutoMod and guild settings, planned and applied from Git | This file |
| `bot/` | Cloudflare Worker bot: GitHub webhooks into Discord, linked roles | [bot/README.md](bot/README.md) |

```mermaid
flowchart LR
  J[server.json] --> P[plan]
  L[(live server)] -->|GET guild, channels, roles, emojis, onboarding, welcome screen, AutoMod| P
  P -->|plan / apply| R[printed diff]
  P -->|apply --yes| S[snapshot] --> A[apply phases: roles ... guild] --> B[read back: no diff]
  S -.->|restore --yes| L
```

## Commands

The bot token is read from `OPENDRONE_DISCORD_BOT_TOKEN` in the environment, else
from `~/.config/incutec/credentials.env`. Python 3.10+, standard library only.
If Python has no CA store (python.org builds on macOS), `/etc/ssl/cert.pem` is used.

| Command | Reads | Writes |
|---|---|---|
| `python3 discord_config.py plan` | Live server | Nothing; prints the diff |
| `python3 discord_config.py plan --verbose` | Live server | Nothing; every permission and role name |
| `python3 discord_config.py apply` | Live server | Nothing; same diff, then "Dry run" when there is a change |
| `python3 discord_config.py apply --yes` | Live server | Snapshot, then phase by phase (roles, categories, channels, positions, archive, onboarding, welcome screen, AutoMod, guild) with a fresh fetch after each phase that wrote, then reads back |
| `python3 discord_config.py audit` | Live server | Snapshot only |
| `python3 discord_config.py restore snapshots/<file>.json` | Live server, the snapshot | Nothing; lists what would be restored |
| `python3 discord_config.py restore snapshots/<file>.json --yes` | Live server, the snapshot | `before-restore` snapshot, then overwrites and category of managed and archived channels, onboarding and welcome screen from the snapshot, then reads back |

"Live server" is the guild, channels, roles, emojis, onboarding, welcome screen
and AutoMod rules. In compact output, permission lists longer than 4 show
`ADMINISTRATOR`, `MANAGE_GUILD`, `MANAGE_ROLES`, `MANAGE_CHANNELS`,
`MANAGE_WEBHOOKS`, `MENTION_EVERYONE`, `BAN_MEMBERS`, `KICK_MEMBERS` and
`MODERATE_MEMBERS` by name and count the rest; identical overwrite changes are
grouped. A role create line lists the role's permissions and an update line the
added and removed ones, in the same form. A new onboarding prompt or option is
printed with the roles and channels each option gives, by name, for example
`prompt 'Where are you from?': new option 'Asia': roles [Asia, Member]`.

`--config <path>` (before the command) uses another file than `server.json`.
Every write carries the audit log reason `OpenDrone-hw/discord discord_config.py`.

## `server.json`

| Key | Meaning |
|---|---|
| `guild_id` | The server |
| `guard` | Lockout guard, see below |
| `profiles` | Named sets of role overwrites: `{role name: {allow: [...], deny: [...]}}`. Permission names are Discord's flag names (`VIEW_CHANNEL`, `SEND_MESSAGES`, ...); `@everyone` is the everyone role |
| `roles[]` | `name`, optional `color` (`#rrggbb`), `hoist`, `mentionable`, `permissions`. Missing roles are created, listed ones updated, none deleted; integration-managed roles are skipped; a change to a role at or above the bot's role is refused |
| `categories[]` | Optional `id`, `name`, `access` (a profile or an inline overwrite set) and `channels[]`. List order is category order |
| `channels[]` | Optional `id`, `name`, optional `type` (`text`, `announcement`, `voice`, `stage`, `forum`, `media`), `topic` (forum post guidelines), `slowmode`, `bitrate`, `user_limit`, `forum`, `access`. Without `access` a channel gets its category's. Without `id` it is matched by name and type inside its category and created when missing. Only `text` and `announcement` convert into each other. Text, announcement, forum and media names must be lowercase without spaces, the form Discord stores; other names are refused. List order is channel order |
| `forum` | `tags[]` (`name`, `emoji`, `moderated`; at most 20, live tags not listed are kept), `default_reaction`, `layout` (`list`, `gallery`), `sort` (`activity`, `creation`), `require_tag`, `post_slowmode` |
| `archive` | `category` (created when missing), `access`, `channels[]`: each listed channel moves into that category and gets its access; messages stay |
| `onboarding` | `enabled`, `mode` (`default`, `advanced`), `default_channels[]`, `prompts[]` with `title`, `type` (`multiple_choice`, `dropdown`), `single_select`, `required`, `in_onboarding`, `options[]` (`title`, `description`, `emoji`, `roles[]`, `channels[]`). Prompts and options match by title; live ones not listed are kept |
| `welcome_screen` | `enabled`, `description`, `channels[]` (at most 5: `channel`, `description`, `emoji`) |
| `automod[]` | Rules matched by `name`: `trigger` (`keyword`, `spam`, `keyword_preset`, `mention_spam`, `member_profile`), optional `event`, `metadata`, `actions[]` (`block` with optional `message`, `alert` with `channel`, `timeout` with `seconds`, `block_interaction`), `enabled`, `exempt_roles[]`, `exempt_channels[]`. Live rules not listed are left alone; per-trigger caps are checked including them |
| `guild` | `description`, `rules_channel`, `public_updates_channel`, `system_channel`, `safety_alerts_channel` |

Only `guild_id`, `profiles` and `categories` are required; a missing optional key
leaves that part of the server unmanaged. Roles are referenced by name; the tool
refuses to run if two roles share a name. Channels are referenced by id,
`Category/name` or a unique name. An emoji is a Unicode emoji or `:name:` for a
custom server emoji. An unknown key, profile, role, permission or emoji, a
permission both allowed and denied, or a channel listed twice stops the run
before any request that writes.

### Onboarding requirement check

Discord refuses an enabled onboarding that does not have enough default
channels. The tool refuses such a plan before any write, using its own
conservative estimate of Discord's rule:

| Counted | Rule |
|---|---|
| Channels | Default channels; a category counts as its channels; `advanced` mode adds the channels options grant |
| At least 7 | Channels `@everyone` can view in the planned state |
| At least 5 | Text or announcement channels `@everyone` can view and send in; forums, media, voice and stage never count here |

| Planned onboarding change | Live `below_requirements` | Check |
|---|---|---|
| `default_channels`, `mode` or `enabled` changes, onboarding ends enabled | any | Enforced |
| Only prompts change, onboarding enabled | `true` or missing | Enforced |
| Only prompts change, onboarding enabled | `false` | Skipped; the plan prints a note with the estimate |
| Onboarding ends disabled, or nothing changes | any | Skipped |

### Lockout guard

| `guard` key | Default | Rule |
|---|---|---|
| `protected_roles` | `["admin"]` | Never denied `VIEW_CHANNEL` by any planned overwrite and never lose `ADMINISTRATOR` or `VIEW_CHANNEL`; the bot's own role is always included |
| `gating_roles` | `["Newbie", "Member"]` | A member holding `@everyone` plus any mix of these roles (none included) must be able to view the channels in the table below, in the planned state |
| `must_see` | `["welcome", "rules"]` | Channels every gating mix must see |
| `protected_channels` | `[]` | Ids of existing channels that are never managed or archived; a name or unknown id is refused |
| `unassignable_roles` | `[]` | Roles no onboarding option may give; each must exist or be listed in `roles` |

Channels every gating mix must view (gating model A):

| Channel | Checked when |
|---|---|
| `must_see` channel, onboarding default channel, default category | Always |
| Channel inside a default category | `@everyone` alone can view it |
| Any category or channel managed or archived by `server.json` | `@everyone` alone can view it |

So a leftover `Newbie` or `Member` deny on a channel `@everyone` can see is
refused; staff and private channels, which `@everyone` alone cannot see, are
skipped. A violation is refused when the channel is managed or archived by
`server.json`, when the plan changes a gating role's permissions, or, for
default channels, when the plan changes onboarding. A violation in an unmanaged
channel the plan does not change is printed as a note instead.

Onboarding options give their roles to any member who picks them. Every option
in the planned onboarding, listed or kept from the live server, is refused when
a role it gives is:

| Role | Example |
|---|---|
| `@everyone` | |
| A `protected_roles` role or the bot's role | `admin`, `OpenDrone Dev` |
| Managed by an integration | `carl-bot`, `Server Booster` |
| In `unassignable_roles` | `developer`, `reviewer` |
| Holding a privileged permission after the plan | `ADMINISTRATOR`, `MANAGE_GUILD`, `MANAGE_ROLES`, `MANAGE_CHANNELS`, `MANAGE_WEBHOOKS`, `MENTION_EVERYONE`, `BAN_MEMBERS`, `KICK_MEMBERS`, `MODERATE_MEMBERS` |

The check is strict when the plan changes onboarding or that role's
permissions; otherwise a live violation is printed as a note.

## Safety rules

| Rule | Effect |
|---|---|
| Only listed things are managed | Channels, roles, prompts, options, forum tags and AutoMod rules not in `server.json` are reported as unmanaged and never touched |
| Nothing is deleted | The REST client refuses DELETE; retiring a channel moves it to the `archive` category |
| Member overwrites are kept by apply | Only role overwrites are compared and written; `apply --yes` copies member overwrites into its PATCH unchanged |
| Snapshot before every apply | `snapshots/` (git-ignored) holds guild, channels, roles, emojis, onboarding, welcome screen and AutoMod as fetched |
| Read back after every apply | `apply --yes` fails if the server still differs from `server.json` |
| Restore | `restore --yes` saves a `before-restore` snapshot, writes the snapshot's full overwrite list (member overwrites included) and category for managed and archived channels present in the snapshot, onboarding and the welcome screen, then reads back. Names, topics, roles, AutoMod and guild settings are not restored |
| Audit log and rate limits | `X-Audit-Log-Reason` on every call; on 429 the tool waits `retry_after`, and it waits `X-RateLimit-Reset-After` when a bucket is empty; 6 attempts per request |

## Manual steps (Discord UI only)

These have no API, or are outside what `discord_config.py` manages.

| Step | Where | Why |
|---|---|---|
| Server Guide: welcome sign, new member to-dos, resource pages | Server Settings, Onboarding, Server Guide | Discord has no API for the Server Guide |
| Self-assign role picker in #roles | carl-bot dashboard, reaction roles | The picker is carl-bot reaction roles; `discord_config.py` does not manage carl-bot. Turning off its reaction roles after onboarding prompts replace them is a manual step |
| Attach linked roles to a role | Server Settings, Roles, the role, Links: add `OpenDrone Dev` and set its requirements | No API; the metadata comes from the bot, see [bot/README.md](bot/README.md) |
| Re-enable "Require 2FA for moderator actions" | Server Settings, Safety Setup | It is off so the bot can write. Turn it on again after the `OpenDrone Dev` application moves to a Developer Team whose owner has 2FA, then check the bot still writes |

## Bot application

`OpenDrone Dev` (application id `1553748824470851644`) is private: only its owner
can install it. `discord_config.py` and the Worker in `bot/` use the same
application. Its role must stay above every role it assigns, and it holds
Administrator while the layout is built.

## Validation

```sh
python3 -m unittest discover -s tests       # config tool, offline
cd bot && npm ci && npm test && npx tsc --noEmit
```

## Licence

MIT
