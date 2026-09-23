# Fortnite Bracket Bot

Discord bot for Fortnite bracket sign ups: a Sign Up button, private admin review channels with
Accept / Deny, DMs with the result, a numbered accepted-teams list, `/tournament` to open sign ups,
and an automatic Community role.

## Files
- `bot.js` – the bot itself
- `index.js` – the updater. It starts `bot.js` and checks this GitHub repo every minute;
  when the code changes it downloads the new `bot.js` / `package.json` and restarts the bot.
- `.env` – the bot token (`DISCORD_TOKEN=...`). **Never commit it.** It only lives on the host.

## Hosting (Wispbyte)
The host needs `index.js`, `bot.js`, `package.json` and `.env`, with the start file set to `index.js`.
After that, pushing to `main` on GitHub updates the bot automatically within about a minute.

Invite link:
https://discord.com/oauth2/authorize?client_id=1552270136659152916&permissions=268528656&scope=bot+applications.commands

## Commands (admins / `.` role only)
Type `!help` in Discord for the full guide.

| Command | What it does |
|---|---|
| `/tournament` | Opens sign ups: pick mode (1v1–4v4), type (Zonewars, Realistics, Boxfights, Buildfights) and region (East, West, Central). Clears the old teams list. |
| `!reset` | Clears the teams list, removes the Sign Up button and shows "Sign ups are closed" |
| `!remove <number>` | Removes one team. Teams below it move up a number. |
| `!teams` | Reposts the teams list |
| `!setup` | Reposts the Sign Up button |
| `!check` | Fixes the setup and shows a ✅/❌ checklist |
| `!help` | Shows the command guide |
