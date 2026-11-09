const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.MODEL || "openai/gpt-oss-120b";
const TOKEN = process.env.APP_TOKEN;
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /render\.com/.test(process.env.DATABASE_URL || "") ? { rejectUnauthorized: false } : false,
});

db.query(`
CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, player_id TEXT, role TEXT, content TEXT);
CREATE TABLE IF NOT EXISTS summaries (player_id TEXT PRIMARY KEY, summary TEXT);
CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, project TEXT, content TEXT);
CREATE TABLE IF NOT EXISTS lessons (id SERIAL PRIMARY KEY, lesson TEXT);
`).catch(console.error);

const SYS = {
  chat: "You are a friendly NPC in a Roblox game. Stay in character. Max 2 sentences.",
  code: "You are an expert Roblox Luau engineer. Output only working, server-safe Luau with short comments. Use task.wait, validate all RemoteEvent input on the server, never trust the client.",
  map: 'You are a Roblox map designer. Return ONLY JSON, no markdown: {"name":string,"parts":[{"shape":"Block|Ball|Cylinder|Wedge","pos":[x,y,z],"size":[x,y,z],"color":[r,g,b],"material":string}]}. Max 150 parts, ground at y=0, within 200 studs of origin, no floating parts.',
};

const same = (a, b) => {
  const x = Buffer.from(a || ""), y = Buffer.from(b || "");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const auth = (req, res, next) =>
  TOKEN && same(req.get("x-token"), TOKEN) ? next() : res.status(401).json({ error: "Unauthorized" });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function groq(system, messages, effort = "medium") {
  const body = { model: MODEL, messages: [{ role: "system", content: system }, ...messages] };
  if (MODEL.includes("gpt-oss")) body.reasoning_effort = effort;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      if (r.status === 429 || r.status >= 500) throw new Error("retry " + r.status);
      const d = await r.json();
      if (d.error) console.error("groq error:", d.error.message);
      return d.choices?.[0]?.message?.content || "";
    } catch (e) {
      console.error("groq:", e.message);
      await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
    }
  }
  return "";
}

const addLesson = (t) =>
  db.query(
    "INSERT INTO lessons(lesson) SELECT $1::text WHERE NOT EXISTS (SELECT 1 FROM lessons WHERE lesson=$1::text)",
    [String(t).slice(0, 300)]);

async function context(project, query = "") {
  const q = String(query).slice(0, 500);
  const n = await db.query(
    "SELECT content FROM notes WHERE project=$1 ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $2)) DESC, id DESC LIMIT 12",
    [project, q]);
  const l = await db.query(
    "SELECT lesson FROM lessons ORDER BY ts_rank(to_tsvector('english', lesson), plainto_tsquery('english', $1)) DESC, id DESC LIMIT 12",
    [q]);
  return `\nProject notes:\n${n.rows.map((r) => "- " + r.content).join("\n")}\nLessons learned (do not repeat these mistakes):\n${l.rows.map((r) => "- " + r.lesson).join("\n")}`;
}

async function compact(id) {
  const c = await db.query("SELECT count(*)::int AS n FROM messages WHERE player_id=$1", [id]);
  if (c.rows[0].n <= 30) return;
  const old = await db.query("SELECT id, role, content FROM messages WHERE player_id=$1 ORDER BY id LIMIT 18", [id]);
  const s = await db.query("SELECT summary FROM summaries WHERE player_id=$1", [id]);
  const summary = await groq(
    "Merge into short durable facts about the player and story. Max 120 words.",
    [{ role: "user", content: (s.rows[0]?.summary || "") + "\n" + JSON.stringify(old.rows.map((r) => ({ role: r.role, content: r.content }))) }],
    "low");
  if (!summary) return;
  await db.query("INSERT INTO summaries(player_id, summary) VALUES ($1,$2) ON CONFLICT (player_id) DO UPDATE SET summary=$2", [id, summary]);
  await db.query("DELETE FROM messages WHERE id = ANY($1)", [old.rows.map((r) => r.id)]);
}

app.get("/", (req, res) => res.send("ok"));
app.get("/health", wrap(async (req, res) => {
  await db.query("SELECT 1");
  res.json({ ok: true, model: MODEL });
}));

app.post("/chat", async (req, res) => {
  try {
    const id = String(req.body.playerId || "anon").slice(0, 50);
    const msg = String(req.body.message || "").slice(0, 500);
    const s = await db.query("SELECT summary FROM summaries WHERE player_id=$1", [id]);
    const h = await db.query(
      "SELECT role, content FROM (SELECT id, role, content FROM messages WHERE player_id=$1 ORDER BY id DESC LIMIT 12) t ORDER BY id", [id]);
    const p = await db.query("SELECT content FROM notes WHERE project='npc' ORDER BY id DESC LIMIT 10");
    const system = SYS.chat
      + (p.rows.length ? "\nPersonality and world facts:\n" + p.rows.map((r) => "- " + r.content).join("\n") : "")
      + (s.rows[0]?.summary ? "\nWhat you remember about this player: " + s.rows[0].summary : "");
    const reply = await groq(system, [...h.rows, { role: "user", content: msg }], "low");
    if (!reply) return res.status(502).json({ reply: "..." });
    await db.query("INSERT INTO messages(player_id, role, content) VALUES ($1,'user',$2),($1,'assistant',$3)", [id, msg, reply]);
    await compact(id);
    res.json({ reply });
  } catch (e) { console.error(e); res.status(500).json({ reply: "Error" }); }
});

app.post("/notes", auth, wrap(async (req, res) => {
  await db.query("INSERT INTO notes(project, content) VALUES ($1,$2)",
    [String(req.body.project || "main").slice(0, 50), String(req.body.content || "").slice(0, 2000)]);
  res.json({ ok: true });
}));
app.get("/notes", auth, wrap(async (req, res) => {
  const r = await db.query("SELECT id, content FROM notes WHERE project=$1 ORDER BY id DESC LIMIT 50", [req.query.project || "main"]);
  res.json(r.rows);
}));
app.delete("/notes/:id", auth, wrap(async (req, res) => {
  await db.query("DELETE FROM notes WHERE id=$1", [parseInt(req.params.id) || 0]);
  res.json({ ok: true });
}));

app.post("/lessons", auth, wrap(async (req, res) => {
  await addLesson(req.body.lesson || "");
  res.json({ ok: true });
}));
app.get("/lessons", auth, wrap(async (req, res) => {
  const r = await db.query("SELECT id, lesson FROM lessons ORDER BY id DESC LIMIT 50");
  res.json(r.rows);
}));
app.delete("/lessons/:id", auth, wrap(async (req, res) => {
  await db.query("DELETE FROM lessons WHERE id=$1", [parseInt(req.params.id) || 0]);
  res.json({ ok: true });
}));

app.post("/code", auth, async (req, res) => {
  try {
    const ask = String(req.body.prompt || "").slice(0, 2000);
    const sys = SYS.code + (await context(req.body.project || "main", ask));
    const draft = await groq(sys, [{ role: "user", content: ask }], "high");
    const final = await groq(
      sys + "\nYou are now reviewing code. Fix bugs, deprecated APIs and security holes. Return only the final code.",
      [{ role: "user", content: `Task: ${ask}\n\nDraft:\n${draft}` }], "high");
    if (!final) return res.status(502).json({ error: "AI unavailable" });
    const lesson = (await groq(
      "In one short sentence, state the main mistake the final code fixed compared to the draft. Reply NONE if nothing important.",
      [{ role: "user", content: `Draft:\n${draft}\n\nFinal:\n${final}` }], "low")).trim();
    if (lesson && !/^none/i.test(lesson)) await addLesson(lesson);
    res.json({ code: final });
  } catch (e) { console.error(e); res.status(500).json({ error: "Error" }); }
});

function cleanMap(raw) {
  const j = JSON.parse(raw.replace(/```json|```/g, "").trim());
  const clamp = (v, lim) => Math.max(-lim, Math.min(lim, Number(v) || 0));
  j.parts = (j.parts || []).slice(0, 150).map((p) => ({
    shape: ["Block", "Ball", "Cylinder", "Wedge"].includes(p.shape) ? p.shape : "Block",
    pos: (p.pos || [0, 0, 0]).map((v) => clamp(v, 200)),
    size: (p.size || [4, 1, 4]).map((v) => Math.max(1, clamp(v, 100))),
    color: (p.color || [128, 128, 128]).map((v) => Math.max(0, Math.min(255, Number(v) || 0))),
    material: String(p.material || "Plastic"),
  }));
  return j;
}

app.post("/map", auth, async (req, res) => {
  try {
    const ask = String(req.body.prompt || "").slice(0, 1000);
    const sys = SYS.map + (await context(req.body.project || "main", ask));
    for (let i = 0; i < 2; i++) {
      try { return res.json(cleanMap(await groq(sys, [{ role: "user", content: ask }], "high"))); } catch (e) {}
    }
    res.status(500).json({ error: "Map failed" });
  } catch (e) { console.error(e); res.status(500).json({ error: "Error" }); }
});

require("./agents")(app, { groq, db, auth, wrap, context, addLesson });

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});
process.on("unhandledRejection", (e) => console.error("unhandled:", e));

app.listen(process.env.PORT || 3000);
