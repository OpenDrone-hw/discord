# OpenDrone Discord

Configuration as code for the OpenDrone Discord server. Read `README.md` first.

- Validate: `python3 -m unittest discover -s tests`, then `python3 discord_config.py plan`.
- `server.json` is the only place layout and permissions are changed. Do not click
  a managed channel's permissions in the Discord UI; the next apply reverts it.
- `apply --yes` changes a live server with hundreds of members. Run it only after
  the person who asked has seen the `plan` output for that exact change.
- Never delete channels, roles or messages from a script. Archive by hand.
- Never print or commit the bot token; refer to `OPENDRONE_DISCORD_BOT_TOKEN`.
- `snapshots/` contains member-visible server state and stays out of Git.
- Standard library only; no dependencies.
