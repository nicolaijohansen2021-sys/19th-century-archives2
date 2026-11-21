require("dotenv").config();
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();
const isProd = process.env.NODE_ENV === "production";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined
});

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Configure a PostgreSQL database before starting.");
  process.exit(1);
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET must be at least 32 characters.");
  process.exit(1);
}
if (isProd && (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET)) {
  console.error("Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET before production deployment.");
  process.exit(1);
}
if (isProd && (!process.env.ADMIN_PASSWORD_1 || !process.env.ADMIN_PASSWORD_2 || !process.env.ADMIN_PASSWORD_3)) {
  console.error("Set all three admin passwords in the hosting environment.");
  process.exit(1);
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new PgSession({ pool, tableName: "session", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProd, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const adminAccounts = [1,2,3].map(i => ({
  username: process.env[`ADMIN_USERNAME_${i}`] || ["", "HeadAdmin", "Admin02", "Admin03"][i],
  password: process.env[`ADMIN_PASSWORD_${i}`] || ""
})).filter(a => a.password);

const schema = `
CREATE TABLE IF NOT EXISTS applications (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  discord_username TEXT NOT NULL,
  answers JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','denied')),
  admin_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS applications_discord_id_idx ON applications(discord_id);
`;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requireDiscord(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Please sign in with Discord first." });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: "Administrator login required." });
  next();
}
function safeUser(user) {
  return user ? { id: user.id, username: user.username, global_name: user.global_name, avatar: user.avatar } : null;
}

app.get("/auth/discord", (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) return res.status(503).send("Discord login is not configured yet.");
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state
  });
  res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send("Discord sign-in could not be verified. Please try again.");
    delete req.session.oauthState;
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error("Discord token exchange failed.");
    const profileResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok) throw new Error("Could not read Discord profile.");
    req.session.user = { id: profile.id, username: profile.username, global_name: profile.global_name, avatar: profile.avatar };
    req.session.admin = null;
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).send("Discord login failed. Please return to the website and try again.");
  }
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  const match = adminAccounts.find(a => safeEqual(a.username, username || "") && safeEqual(a.password, password || ""));
  if (!match) return res.status(401).json({ error: "Incorrect administrator username or password." });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not start admin session." });
    req.session.admin = { username: match.username };
    req.session.user = null;
    res.json({ ok: true, admin: req.session.admin });
  });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", (req, res) => res.json({ user: safeUser(req.session.user), admin: req.session.admin || null }));

app.get("/api/my-application", requireDiscord, async (req, res) => {
  const result = await pool.query("SELECT * FROM applications WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 1", [req.session.user.id]);
  res.json({ application: result.rows[0] || null });
});
app.post("/api/applications", requireDiscord, async (req, res) => {
  const existing = await pool.query("SELECT * FROM applications WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 1", [req.session.user.id]);
  if (existing.rows[0] && existing.rows[0].status !== "denied") return res.status(409).json({ error: "You already have an application. Check its status on your account page." });
  if (existing.rows[0] && existing.rows[0].status === "denied") return res.status(403).json({ error: "Your application was denied. Contact an administrator on Discord and ask them to reset it before applying again." });
  const fields = ["minecraft","age","timezone","experience","why","nation","extra"];
  const answers = {};
  for (const key of fields) answers[key] = String((req.body || {})[key] || "").trim().slice(0, 4000);
  if (fields.some(k => !answers[k])) return res.status(400).json({ error: "Please complete every required field." });
  const result = await pool.query(
    "INSERT INTO applications(discord_id,discord_username,answers) VALUES($1,$2,$3) RETURNING *",
    [req.session.user.id, req.session.user.global_name || req.session.user.username, answers]
  );
  res.json({ application: result.rows[0] });
});

app.get("/api/admin/applications", requireAdmin, async (req, res) => {
  const result = await pool.query("SELECT * FROM applications ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC");
  res.json({ applications: result.rows });
});
app.patch("/api/admin/applications/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: "Invalid application ID." });
  const { action, answers, admin_note } = req.body || {};
  if (!["edit","accept","deny","reset"].includes(action)) return res.status(400).json({ error: "Invalid action." });
  const found = await pool.query("SELECT * FROM applications WHERE id=$1", [id]);
  if (!found.rows[0]) return res.status(404).json({ error: "Application not found." });
  let row = found.rows[0];
  if (action === "edit") {
    if (!answers || typeof answers !== "object") return res.status(400).json({ error: "No edited answers provided." });
    const clean = {};
    for (const key of ["minecraft","age","timezone","experience","why","nation","extra"]) clean[key] = String(answers[key] || "").slice(0,4000);
    const result = await pool.query("UPDATE applications SET answers=$1, admin_note=$2, updated_at=NOW() WHERE id=$3 RETURNING *", [clean, String(admin_note || "").slice(0,2000), id]);
    row = result.rows[0];
  } else if (action === "reset") {
    await pool.query("DELETE FROM applications WHERE id=$1", [id]);
    return res.json({ ok: true, reset: true });
  } else {
    const status = action === "accept" ? "accepted" : "denied";
    const result = await pool.query("UPDATE applications SET status=$1, admin_note=$2, reviewed_by=$3, updated_at=NOW() WHERE id=$4 RETURNING *",
      [status, String(admin_note || "").slice(0,2000), req.session.admin.username, id]);
    row = result.rows[0];
  }
  res.json({ application: row });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

(async () => {
  try {
    await pool.query(schema);
    app.listen(process.env.PORT || 3000, () => console.log(`The 19th Century Archives running on port ${process.env.PORT || 3000}`));
  } catch (err) {
    console.error("Database initialization failed:", err);
    process.exit(1);
  }
})();
