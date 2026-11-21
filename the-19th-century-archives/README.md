# Age of Nations

A Victorian-inspired Minecraft roleplay community website set in the year 1800. Nations, kingdoms, republics and empires are fictional entities created by players in-game.

## Features

- Discord OAuth sign-in (identity only; does not currently verify membership in a Discord guild).
- Player applications linked automatically to the signed-in Discord user.
- Admin review tools with pending, accepted and denied application sections.
- Admin editing of submitted answers, decisions and staff notes.
- Reset of denied applications so a player can apply again.
- Admin-managed application categories (for example Whitelist, Staff and Admin), open/closed controls, and editable questions.
- Admin-managed nations directory, historical entries, rulebook content and homepage welcome text/announcements.
- PostgreSQL-backed sessions and content.

## Hosting

The application is designed for Node.js 20+, Express and PostgreSQL. The current deployment uses Render for the web service and Supabase PostgreSQL for storage.

Set the following environment variables in the hosting provider:

- `NODE_ENV=production`
- `DATABASE_URL` — PostgreSQL connection string
- `PGSSLMODE=require` when using a provider that requires SSL
- `SESSION_SECRET` — a random secret of at least 32 characters
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` — `https://YOUR-SERVICE.onrender.com/auth/discord/callback`
- `ADMIN_USERNAME_1`, `ADMIN_PASSWORD_1`
- `ADMIN_USERNAME_2`, `ADMIN_PASSWORD_2`
- `ADMIN_USERNAME_3`, `ADMIN_PASSWORD_3`
- `DISCORD_INVITE` — optional invite URL (the current public page also has the configured invite link)

Never commit credentials or paste them into chats. If a credential has been exposed, rotate it in the provider dashboard and update the hosting environment variable.

## Deployment

The Render service should use this folder as its Root Directory:

`the-19th-century-archives`

Build command: `npm install`

Start command: `npm start`

The database tables are created and migrated automatically when the server starts. Existing application records are retained; the new application category field defaults older records to Whitelist.

## Discord OAuth scope

The site requests the `identify` scope to obtain the applicant's Discord ID and username. It does not currently check whether the user belongs to the Discord server. Guild membership verification would require a separate bot or additional OAuth configuration.
