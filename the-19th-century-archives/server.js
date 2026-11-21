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

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required."); process.exit(1); }
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) { console.error("SESSION_SECRET must be at least 32 characters."); process.exit(1); }
if (isProd && (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET)) { console.error("Set Discord OAuth credentials."); process.exit(1); }
if (isProd && [1,2,3].some(i => !process.env["ADMIN_PASSWORD_"+i])) { console.error("Set all three admin passwords."); process.exit(1); }

app.set("trust proxy", 1);
app.use(express.json({ limit: "150kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new PgSession({ pool, tableName: "session", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProd, maxAge: 7*24*60*60*1000 }
}));

const adminAccounts=[1,2,3].map(i=>({
  username:process.env["ADMIN_USERNAME_"+i]||["","HeadAdmin","Admin02","Admin03"][i],
  password:process.env["ADMIN_PASSWORD_"+i]||""
})).filter(a=>a.password);

const schema = \`
CREATE TABLE IF NOT EXISTS applications (
 id BIGSERIAL PRIMARY KEY, discord_id TEXT NOT NULL, discord_username TEXT NOT NULL,
 answers JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','accepted','denied')), admin_note TEXT NOT NULL DEFAULT '',
 reviewed_by TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS application_type TEXT NOT NULL DEFAULT 'Whitelist';
CREATE INDEX IF NOT EXISTS applications_discord_id_idx ON applications(discord_id);

CREATE TABLE IF NOT EXISTS site_content (
 id BIGSERIAL PRIMARY KEY, section TEXT NOT NULL CHECK(section IN ('nation','history','rulebook','home')),
 title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
 sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS application_types (
 id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
 is_open BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS application_questions (
 id BIGSERIAL PRIMARY KEY, type_id BIGINT NOT NULL REFERENCES application_types(id) ON DELETE CASCADE,
 question TEXT NOT NULL, field_key TEXT NOT NULL, required BOOLEAN NOT NULL DEFAULT TRUE,
 sort_order INTEGER NOT NULL DEFAULT 0
);
\`;

function safeEqual(a,b){const aa=Buffer.from(String(a));const bb=Buffer.from(String(b));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}
function requireDiscord(req,res,next){if(!req.session.user)return res.status(401).json({error:"Please sign in with Discord first."});next();}
function requireAdmin(req,res,next){if(!req.session.admin)return res.status(401).json({error:"Administrator login required."});next();}
function safeUser(u){return u?{id:u.id,username:u.username,global_name:u.global_name,avatar:u.avatar}:null;}
function cleanText(v,max=4000){return String(v??"").trim().slice(0,max);}
function validId(v){const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null;}

app.get("/auth/discord",(req,res)=>{
 if(!process.env.DISCORD_CLIENT_ID||!process.env.DISCORD_CLIENT_SECRET)return res.status(503).send("Discord login is not configured.");
 const state=crypto.randomBytes(24).toString("hex");req.session.oauthState=state;
 const params=new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,redirect_uri:process.env.DISCORD_REDIRECT_URI,response_type:"code",scope:"identify",state});
 res.redirect("https://discord.com/oauth2/authorize?"+params.toString());
});
app.get("/auth/discord/callback",async(req,res)=>{
 try{
  if(!req.query.code||!req.query.state||req.query.state!==req.session.oauthState)return res.status(400).send("Discord sign-in could not be verified. Please try again.");
  delete req.session.oauthState;
  const tr=await fetch("https://discord.com/api/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:"authorization_code",code:req.query.code,redirect_uri:process.env.DISCORD_REDIRECT_URI})});
  const token=await tr.json();if(!tr.ok)throw new Error("Discord token exchange failed.");
  const pr=await fetch("https://discord.com/api/users/@me",{headers:{Authorization:"Bearer "+token.access_token}});
  const profile=await pr.json();if(!pr.ok)throw new Error("Could not read Discord profile.");
  req.session.user={id:profile.id,username:profile.username,global_name:profile.global_name,avatar:profile.avatar};req.session.admin=null;res.redirect("/");
 }catch(e){console.error(e);res.status(500).send("Discord login failed. Please try again.");}
});
app.post("/api/admin/login",(req,res)=>{
 const {username,password}=req.body||{};
 const match=adminAccounts.find(a=>safeEqual(a.username,username||"")&&safeEqual(a.password,password||""));
 if(!match)return res.status(401).json({error:"Incorrect administrator username or password."});
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:"Could not start admin session."});req.session.admin={username:match.username};req.session.user=null;res.json({ok:true,admin:req.session.admin});});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",(req,res)=>res.json({user:safeUser(req.session.user),admin:req.session.admin||null}));

// Public content and application form definitions
app.get("/api/content",async(req,res)=>{
 const r=await pool.query("SELECT * FROM site_content ORDER BY section,sort_order,id");
 res.json({items:r.rows});
});
app.get("/api/application-types",async(req,res)=>{
 const r=await pool.query("SELECT id,name,description,is_open,sort_order FROM application_types ORDER BY sort_order,id");
 const q=await pool.query("SELECT id,type_id,question,field_key,required,sort_order FROM application_questions ORDER BY sort_order,id");
 res.json({types:r.rows.map(t=>({...t,questions:q.rows.filter(x=>x.type_id===t.id)}))});
});
app.get("/api/my-applications",requireDiscord,async(req,res)=>{
 const r=await pool.query("SELECT id,application_type,answers,status,admin_note,created_at,updated_at FROM applications WHERE discord_id=$1 ORDER BY created_at DESC",[req.session.user.id]);
 res.json({applications:r.rows});
});
app.get("/api/my-application",requireDiscord,async(req,res)=>{
 const r=await pool.query("SELECT * FROM applications WHERE discord_id=$1 ORDER BY created_at DESC LIMIT 1",[req.session.user.id]);
 res.json({application:r.rows[0]||null});
});
app.post("/api/applications",requireDiscord,async(req,res)=>{
 const typeId=validId(req.body?.type_id);if(!typeId)return res.status(400).json({error:"Choose an application type."});
 const typeResult=await pool.query("SELECT * FROM application_types WHERE id=$1",[typeId]);
 const type=typeResult.rows[0];if(!type)return res.status(404).json({error:"Application type not found."});
 if(!type.is_open)return res.status(403).json({error:"Applications for this category are currently closed."});
 const prior=await pool.query("SELECT id,status FROM applications WHERE discord_id=$1 AND application_type=$2 ORDER BY created_at DESC LIMIT 1",[req.session.user.id,type.name]);
 if(prior.rows[0]&&prior.rows[0].status!=="denied")return res.status(409).json({error:"You already have an application of this type."});
 if(prior.rows[0]&&prior.rows[0].status==="denied")return res.status(403).json({error:"Your previous application was denied. Ask an administrator to reset it before reapplying."});
 const qr=await pool.query("SELECT * FROM application_questions WHERE type_id=$1 ORDER BY sort_order,id",[typeId]);
 if(!qr.rows.length)return res.status(400).json({error:"This application form has not been configured yet."});
 const answers={};
 for(const q of qr.rows){const v=cleanText(req.body?.answers?.[q.field_key],4000);if(q.required&&!v)return res.status(400).json({error:"Please answer: "+q.question});answers[q.field_key]=v;}
 const r=await pool.query("INSERT INTO applications(discord_id,discord_username,application_type,answers) VALUES($1,$2,$3,$4) RETURNING id,application_type,answers,status,created_at",[req.session.user.id,req.session.user.global_name||req.session.user.username,type.name,answers]);
 res.json({application:r.rows[0]});
});

// Admin application review
app.get("/api/admin/applications",requireAdmin,async(req,res)=>{
 const r=await pool.query("SELECT * FROM applications ORDER BY created_at DESC");res.json({applications:r.rows});
});
app.patch("/api/admin/applications/:id",requireAdmin,async(req,res)=>{
 const id=validId(req.params.id);if(!id)return res.status(400).json({error:"Invalid application ID."});
 const {action}=req.body||{};const found=await pool.query("SELECT * FROM applications WHERE id=$1",[id]);if(!found.rows[0])return res.status(404).json({error:"Application not found."});
 if(action==="reset"){if(found.rows[0].status!=="denied")return res.status(400).json({error:"Only denied applications can be reset."});await pool.query("DELETE FROM applications WHERE id=$1",[id]);return res.json({ok:true,reset:true});}
 if(action==="edit"){
  if(!req.body.answers||typeof req.body.answers!=="object"||Array.isArray(req.body.answers))return res.status(400).json({error:"Edited answers are missing."});
  const clean={};for(const [k,v] of Object.entries(req.body.answers).slice(0,40))clean[cleanText(k,80)]=cleanText(v,4000);
  const r=await pool.query("UPDATE applications SET answers=$1,admin_note=$2,updated_at=NOW() WHERE id=$3 RETURNING *",[clean,cleanText(req.body.admin_note,2000),id]);return res.json({application:r.rows[0]});
 }
 if(!["accept","deny"].includes(action))return res.status(400).json({error:"Invalid action."});
 const status=action==="accept"?"accepted":"denied";
 const r=await pool.query("UPDATE applications SET status=$1,admin_note=$2,reviewed_by=$3,updated_at=NOW() WHERE id=$4 RETURNING *",[status,cleanText(req.body.admin_note,2000),req.session.admin.username,id]);res.json({application:r.rows[0]});
});

// Admin content management
app.post("/api/admin/content",requireAdmin,async(req,res)=>{
 const {section}=req.body||{};if(!["nation","history","rulebook","home"].includes(section))return res.status(400).json({error:"Invalid content section."});
 const r=await pool.query("INSERT INTO site_content(section,title,body,metadata,sort_order) VALUES($1,$2,$3,$4,$5) RETURNING *",[section,cleanText(req.body.title,180),cleanText(req.body.body,12000),req.body.metadata&&typeof req.body.metadata==="object"?req.body.metadata:{},Number(req.body.sort_order)||0]);res.json({item:r.rows[0]});
});
app.patch("/api/admin/content/:id",requireAdmin,async(req,res)=>{
 const id=validId(req.params.id);if(!id)return res.status(400).json({error:"Invalid content ID."});
 const r=await pool.query("UPDATE site_content SET title=$1,body=$2,metadata=$3,sort_order=$4,updated_at=NOW() WHERE id=$5 RETURNING *",[cleanText(req.body.title,180),cleanText(req.body.body,12000),req.body.metadata&&typeof req.body.metadata==="object"?req.body.metadata:{},Number(req.body.sort_order)||0,id]);
 if(!r.rows[0])return res.status(404).json({error:"Content not found."});res.json({item:r.rows[0]});
});
app.delete("/api/admin/content/:id",requireAdmin,async(req,res)=>{
 const id=validId(req.params.id);if(!id)return res.status(400).json({error:"Invalid content ID."});await pool.query("DELETE FROM site_content WHERE id=$1",[id]);res.json({ok:true});
});

// Admin configurable application categories and questions
app.post("/api/admin/application-types",requireAdmin,async(req,res)=>{
 const name=cleanText(req.body.name,80);if(!name)return res.status(400).json({error:"Enter a category name."});
 try{const r=await pool.query("INSERT INTO application_types(name,description,is_open,sort_order) VALUES($1,$2,$3,$4) RETURNING *",[name,cleanText(req.body.description,500),req.body.is_open!==false,Number(req.body.sort_order)||0]);res.json({type:r.rows[0]});}
 catch(e){if(e.code==="23505")return res.status(409).json({error:"That application category already exists."});throw e;}
});
app.patch("/api/admin/application-types/:id",requireAdmin,async(req,res)=>{
 const id=validId(req.params.id);if(!id)return res.status(400).json({error:"Invalid category ID."});
 const r=await pool.query("UPDATE application_types SET name=$1,description=$2,is_open=$3,sort_order=$4,updated_at=NOW() WHERE id=$5 RETURNING *",[cleanText(req.body.name,80),cleanText(req.body.description,500),req.body.is_open===true,Number(req.body.sort_order)||0,id]);
 if(!r.rows[0])return res.status(404).json({error:"Category not found."});res.json({type:r.rows[0]});
});
app.delete("/api/admin/application-types/:id",requireAdmin,async(req,res)=>{
 const id=validId(req.params.id);if(!id)return res.status(400).json({error:"Invalid category ID."});
 const used=await pool.query("SELECT COUNT(*)::int AS count FROM applications a JOIN application_types t ON t.name=a.application_type WHERE t.id=$1",[id]);
 if(used.rows[0].count)return res.status(409).json({error:"This category has applications. Close it instead of deleting it so records are preserved."});
 await pool.query("DELETE FROM application_types WHERE id=$1",[id]);res.json({ok:true});
});
app.post("/api/admin/application-types/:id/questions",requireAdmin,async(req,res)=>{
 const id=validId(req.params.id);const question=cleanText(req.body.question,300);const field=cleanText(req.body.field_key,60).toLowerCase().replace(/[^a-z0-9_]/g,"_");
 if(!id||!question||!field)return res.status(400).json({error:"Enter a question and a short field key."});
 const r=await pool.query("INSERT INTO application_questions(type_id,question,field_key,required,sort_order) VALUES($1,$2,$3,$4,$5) RETURNING *",[id,question,field,req.body.required!==false,Number(req.body.sort_order)||0]);res.json({question:r.rows[0]});
});
app.patch("/api/admin/questions/:id",requireAdmin,async(req,res)=>{
 const id=validId(req.params.id);if(!id)return res.status(400).json({error:"Invalid question ID."});
 const question=cleanText(req.body.question,300);const field=cleanText(req.body.field_key,60).toLowerCase().replace(/[^a-z0-9_]/g,"_");
 const r=await pool.query("UPDATE application_questions SET question=$1,field_key=$2,required=$3,sort_order=$4 WHERE id=$5 RETURNING *",[question,field,req.body.required===true,Number(req.body.sort_order)||0,id]);
 if(!r.rows[0])return res.status(404).json({error:"Question not found."});res.json({question:r.rows[0]});
});
app.delete("/api/admin/questions/:id",requireAdmin,async(req,res)=>{
 const id=validId(req.params.id);if(!id)return res.status(400).json({error:"Invalid question ID."});await pool.query("DELETE FROM application_questions WHERE id=$1",[id]);res.json({ok:true});
});

app.use(express.static(path.join(__dirname,"public")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

(async()=>{
 try{
  await pool.query(schema);
  const seed=await pool.query("SELECT id FROM application_types WHERE name='Whitelist'");
  if(!seed.rows[0]){
   const t=await pool.query("INSERT INTO application_types(name,description,is_open,sort_order) VALUES('Whitelist','Apply to join Age of Nations.',TRUE,1) RETURNING id");
   const questions=[
    ["Minecraft username","minecraft",true],["Age","age",true],["Timezone","timezone",true],
    ["Previous Minecraft roleplay experience","experience",true],["Why do you want to join Age of Nations?","why",true],
    ["What nation or role are you interested in?","nation",true],["Anything else staff should know?","extra",true]
   ];
   for(let i=0;i<questions.length;i++)await pool.query("INSERT INTO application_questions(type_id,question,field_key,required,sort_order) VALUES($1,$2,$3,$4,$5)",[t.rows[0].id,...questions[i],i]);
  }
  app.listen(process.env.PORT||3000,()=>console.log("Age of Nations running on port "+(process.env.PORT||3000)));
 }catch(e){console.error("Database initialization failed:",e);process.exit(1);}
})();