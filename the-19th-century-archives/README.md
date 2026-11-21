# The 19th Century Archives

A Victorian-themed Minecraft community website with Discord login, player applications, application status, and a separate administrator dashboard.

## Important security note

The Discord credential previously pasted into chat should be treated as compromised. Go to the Discord Developer Portal, regenerate/reset the OAuth2 client secret, and use the new secret only in your hosting provider's environment variables. Do not put secrets in website files or commit `.env` to GitHub.

The three initial admin accounts are configured from environment variables:
- `HeadAdmin`
- `Admin02`
- `Admin03`

The initial passwords are included in `.env.example` for convenience because they were generated in the conversation. Change all three before making the site public. Never commit `.env`.

## Free hosting architecture

A practical free setup is:
- GitHub: private repository for the code.
- Render: free web service (may sleep when idle).
- Supabase: free PostgreSQL database.

Free-plan limits and availability can change. Supabase free projects may pause after inactivity; check the current provider terms. Render's free web service can have cold starts. For reliable always-on hosting, a paid tier may be needed.

## 1. Create the database (Supabase)

1. Create a free project at https://supabase.com/.
2. Open **Project Settings → Database** and copy the connection string (URI).
3. Use the connection string as `DATABASE_URL`. Replace its password placeholder with your database password.
4. Set `PGSSLMODE=require`.
5. Keep the database password private.

The app creates its `applications` and session tables automatically at startup.

## 2. Create Discord OAuth login

1. Open https://discord.com/developers/applications and create/select your application.
2. Open **OAuth2** and copy the Client ID.
3. Reset/regenerate the Client Secret because the old one was shared in chat.
4. Add this exact redirect URI after you know your Render service URL:
   `https://YOUR-SERVICE.onrender.com/auth/discord/callback`
5. Put the Client ID, new Client Secret and exact redirect URI into Render environment variables.

The app requests only the `identify` OAuth scope. It does not verify Discord server membership. If you want membership-only applications, that needs an additional Discord bot integration.

## 3. Deploy to Render

1. Create a GitHub account if needed and make a **private** repository.
2. Upload the contents of this folder to the repository (not the ZIP itself).
3. Sign in at https://render.com/ and create **New → Web Service**.
4. Connect your GitHub repository.
5. Set:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
6. Choose the Free instance if available.
7. In Render → Environment, add:
   - `NODE_ENV` = `production`
   - `BASE_URL` = your Render URL
   - `DISCORD_CLIENT_ID` = your Discord Client ID
   - `DISCORD_CLIENT_SECRET` = your newly regenerated secret
   - `DISCORD_REDIRECT_URI` = `https://YOUR-SERVICE.onrender.com/auth/discord/callback`
   - `SESSION_SECRET` = a long random string (at least 32 characters)
   - `DATABASE_URL` = Supabase connection URI
   - `PGSSLMODE` = `require`
   - `DISCORD_INVITE` = `https://discord.gg/t2cHTA5GKG`
   - `ADMIN_USERNAME_1` = `HeadAdmin`
   - `ADMIN_PASSWORD_1` = your chosen strong new password
   - `ADMIN_USERNAME_2` = `Admin02`
   - `ADMIN_PASSWORD_2` = your chosen strong new password
   - `ADMIN_USERNAME_3` = `Admin03`
   - `ADMIN_PASSWORD_3` = your chosen strong new password
8. Save changes and deploy.
9. Copy the final Render URL and make sure the Discord redirect URI exactly matches it, including `/auth/discord/callback`.

Generate a session secret locally with:
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

## 4. Local testing (optional)

1. Install Node.js 20 or newer from https://nodejs.org/.
2. Copy `.env.example` to `.env`.
3. Fill in Discord credentials, PostgreSQL URL, and a long session secret.
4. Set `BASE_URL=http://localhost:3000` and `DISCORD_REDIRECT_URI=http://localhost:3000/auth/discord/callback`. Add that localhost redirect in the Discord Developer Portal for local testing.
5. Run `npm install`, then `npm start`.
6. Open http://localhost:3000.

## How applications work

- Public visitors can browse all public pages.
- A player signs in with Discord and submits one application.
- Players can see whether their latest application is pending, accepted or denied.
- Admins sign in separately on the Staff page.
- Admins can view, edit, accept, deny, and reset applications.
- Reset deletes the denied application record, allowing the player to apply again.
- A denied player is instructed to contact an administrator in Discord before requesting a reset.

## Admin credentials

Use the three usernames above with the passwords you set in the Render environment. Passwords are not stored in the source code on the deployed server; keep them in your password manager.

## Notes

- The site does not verify Discord guild membership. OAuth `identify` only confirms the Discord account identity.
- This is an initial production-oriented starter. Before opening applications widely, test player login, admin login, application submission, review, denial, and reset with test accounts.
- Back up your Supabase database regularly.
