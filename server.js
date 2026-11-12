
const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
}));

const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.MODEL || "openai/gpt-oss-120b";
const TOKEN = process.env.APP_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!KEY) console.error("Missing GROQ_API_KEY");
if (!TOKEN) console.error("Missing APP_TOKEN");
if (!DATABASE_URL) console.error("Missing DATABASE_URL");

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: /render\.com/.test(DATABASE_URL || "")
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const SYS = {
  chat: "You are a friendly NPC in a Roblox game. Stay in character. Max 2 sentences.",
  code: "You are an expert Roblox Luau engineer. Output only working, server-safe Luau with short comments. Validate all RemoteEvent input on the server. Never trust the client.",
  map: 'You are a Roblox map designer. Return ONLY JSON: {"name":string,"parts":[{"shape":"Block|Ball|Cylinder|Wedge","pos":[x,y,z],"size":[x,y,z],"color":[r,g,b],"material":string}]}. Max 150 parts. Ground at y=0. Keep builds inside the allowed area.'
};

const same = (a, b) => {
  const x = Buffer.from(a || "");
  const y = Buffer.from(b || "");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const auth = (req, res, next) => {
  if (!TOKEN || !same(req.get("x-token"), TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const wrap = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function playerId(value) {
  const id = String(value || "");
  if (!/^\d{1,20}$/.test(id)) {
    throw new Error("Invalid playerId");
  }
  return id;
}

function chatId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error("Invalid conversationId");
  }
  return id;
}

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      player_id TEXT,
      role TEXT,
      content TEXT
    );

    CREATE TABLE IF NOT EXISTS summaries (
      player_id TEXT PRIMARY KEY,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      project TEXT,
      content TEXT
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id SERIAL PRIMARY KEY,
      lesson TEXT
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id BIGSERIAL PRIMARY KEY,
      player_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS conversations_player_updated
      ON conversations(player_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS conversation_messages_history
      ON conversation_messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS chat_builds (
      conversation_id BIGINT PRIMARY KEY
        REFERENCES conversations(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      build_name TEXT NOT NULL DEFAULT 'Untitled Build',
      build_data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log("Database tables ready");
}

async function groq(system, messages, effort = "medium") {
  if (!KEY) throw new Error("GROQ_API_KEY is missing");

  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      ...messages
    ]
  };

  if (MODEL.includes("gpt-oss")) {
    body.reasoning_effort = effort;
  }

  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${KEY}`
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000)
        }
      );

      const data = await r.json().catch(() => ({}));

      if (!r.ok) {
        const message = data.error?.message || `Groq HTTP ${r.status}`;
        if (r.status !== 429 && r.status < 500) {
          throw new Error(message);
        }
        throw new Error("Temporary Groq error: " + message);
      }

      const reply = data.choices?.[0]?.message?.content;
      if (!reply) throw new Error("Empty AI response");

      return reply;
    } catch (e) {
      console.error("Groq attempt:", e.message);
      if (i === 2) throw e;
      await new Promise(resolve => setTimeout(resolve, 1500 * (i + 1)));
    }
  }

  throw new Error("AI unavailable");
}

const addLesson = async lesson => {
  const value = String(lesson || "").slice(0, 300);
  if (!value) return;

  await db.query(
    `INSERT INTO lessons(lesson)
     SELECT $1
     WHERE NOT EXISTS (
       SELECT 1 FROM lessons WHERE lesson = $1
     )`,
    [value]
  );
};

async function context(project, query = "") {
  const q = String(query).slice(0, 500);
  const n = await db.query(
    `SELECT content FROM notes
     WHERE project = $1
     ORDER BY id DESC LIMIT 12`,
    [String(project).slice(0, 50)]
  );

  const l = await db.query(
    `SELECT lesson FROM lessons
     ORDER BY id DESC LIMIT 12`
  );

  return `
Project notes:
${n.rows.map(r => "- " + r.content).join("\n")}

Lessons learned:
${l.rows.map(r => "- " + r.lesson).join("\n")}

Current request:
${q}
`;
}

async function ownedConversation(id, owner) {
  const result = await db.query(
    `SELECT id, player_id, title
     FROM conversations
     WHERE id = $1 AND player_id = $2`,
    [id, owner]
  );

  return result.rows[0] || null;
}

/* HEALTH */

app.get("/", (req, res) => {
  res.send("Roblox AI Game Creator backend is running.");
});

app.get("/health", wrap(async (req, res) => {
  await db.query("SELECT 1");
  res.json({
    ok: true,
    database: "connected",
    model: MODEL
  });
}));

/* CONVERSATIONS */

app.get("/conversations", auth, wrap(async (req, res) => {
  const owner = playerId(req.query.playerId);

  const result = await db.query(
    `SELECT id, title, created_at, updated_at
     FROM conversations
     WHERE player_id = $1
     ORDER BY updated_at DESC
     LIMIT 100`,
    [owner]
  );

  res.json({ conversations: result.rows });
}));

app.post("/conversations", auth, wrap(async (req, res) => {
  const owner = playerId(req.body.playerId);
  const title = String(req.body.title || "New Chat").slice(0, 80);

  const result = await db.query(
    `INSERT INTO conversations(player_id, title)
     VALUES ($1, $2)
     RETURNING id, title, created_at, updated_at`,
    [owner, title]
  );

  res.status(201).json({
    ok: true,
    conversation: result.rows[0]
  });
}));

app.get("/conversations/:id/messages", auth, wrap(async (req, res) => {
  const owner = playerId(req.query.playerId);
  const id = chatId(req.params.id);

  const conversation = await ownedConversation(id, owner);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const result = await db.query(
    `SELECT id, role, content, created_at
     FROM conversation_messages
     WHERE conversation_id = $1 AND player_id = $2
     ORDER BY id ASC
     LIMIT 500`,
    [id, owner]
  );

  res.json({ messages: result.rows });
}));

app.post("/conversations/:id/messages", auth, wrap(async (req, res) => {
  const owner = playerId(req.body.playerId);
  const id = chatId(req.params.id);
  const role = String(req.body.role || "");
  const content = String(req.body.content || "").slice(0, 14000);

  if (!["user", "assistant"].includes(role)) {
    return res.status(400).json({ error: "Invalid message role" });
  }

  if (!content.trim()) {
    return res.status(400).json({ error: "Message is empty" });
  }

  const conversation = await ownedConversation(id, owner);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const result = await db.query(
    `INSERT INTO conversation_messages
       (conversation_id, player_id, role, content)
     VALUES ($1, $2, $3, $4)
     RETURNING id, role, content, created_at`,
    [id, owner, role, content]
  );

  const title = role === "user" && conversation.title === "New Chat"
    ? content.slice(0, 60)
    : conversation.title;

  await db.query(
    `UPDATE conversations
     SET title = $1, updated_at = now()
     WHERE id = $2 AND player_id = $3`,
    [title, id, owner]
  );

  res.status(201).json({
    ok: true,
    message: result.rows[0]
  });
}));

app.patch("/conversations/:id", auth, wrap(async (req, res) => {
  const owner = playerId(req.body.playerId);
  const id = chatId(req.params.id);
  const title = String(req.body.title || "").trim().slice(0, 80);

  if (!title) {
    return res.status(400).json({ error: "Title is required" });
  }

  const result = await db.query(
    `UPDATE conversations
     SET title = $1, updated_at = now()
     WHERE id = $2 AND player_id = $3
     RETURNING id, title, updated_at`,
    [title, id, owner]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json({ ok: true, conversation: result.rows[0] });
}));

app.delete("/conversations/:id", auth, wrap(async (req, res) => {
  const owner = playerId(req.query.playerId);
  const id = chatId(req.params.id);

  const result = await db.query(
    `DELETE FROM conversations
     WHERE id = $1 AND player_id = $2
     RETURNING id`,
    [id, owner]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json({ ok: true });
}));

/* CHAT-SPECIFIC BUILDS */

app.get("/conversations/:id/build", auth, wrap(async (req, res) => {
  const owner = playerId(req.query.playerId);
  const id = chatId(req.params.id);

  const conversation = await ownedConversation(id, owner);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const result = await db.query(
    `SELECT build_name, build_data, updated_at
     FROM chat_builds
     WHERE conversation_id = $1 AND player_id = $2`,
    [id, owner]
  );

  res.json({
    ok: true,
    build: result.rows[0] || null
  });
}));

/* EXISTING NPC CHAT */

app.post("/chat", auth, wrap(async (req, res) => {
  const owner = playerId(req.body.playerId);
  const msg = String(req.body.message || "").slice(0, 500);

  if (!msg.trim()) {
    return res.status(400).json({ error: "Message is empty" });
  }

  const history = await db.query(
    `SELECT role, content
     FROM (
       SELECT id, role, content
       FROM messages
       WHERE player_id = $1
       ORDER BY id DESC LIMIT 12
     ) old_messages
     ORDER BY id ASC`,
    [owner]
  );

  const reply = await groq(
    SYS.chat,
    [...history.rows, { role: "user", content: msg }],
    "low"
  );

  await db.query(
    `INSERT INTO messages(player_id, role, content)
     VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
    [owner, msg, reply]
  );

  res.json({ reply });
}));

/* NOTES */

app.post("/notes", auth, wrap(async (req, res) => {
  await db.query(
    "INSERT INTO notes(project, content) VALUES ($1, $2)",
    [
      String(req.body.project || "main").slice(0, 50),
      String(req.body.content || "").slice(0, 2000)
    ]
  );
  res.json({ ok: true });
}));

app.get("/notes", auth, wrap(async (req, res) => {
  const result = await db.query(
    "SELECT id, content FROM notes WHERE project=$1 ORDER BY id DESC LIMIT 50",
    [String(req.query.project || "main").slice(0, 50)]
  );
  res.json(result.rows);
}));

app.delete("/notes/:id", auth, wrap(async (req, res) => {
  await db.query(
    "DELETE FROM notes WHERE id=$1",
    [parseInt(req.params.id) || 0]
  );
  res.json({ ok: true });
}));

/* LESSONS */

app.post("/lessons", auth, wrap(async (req, res) => {
  await addLesson(req.body.lesson);
  res.json({ ok: true });
}));

app.get("/lessons", auth, wrap(async (req, res) => {
  const result = await db.query(
    "SELECT id, lesson FROM lessons ORDER BY id DESC LIMIT 50"
  );
  res.json(result.rows);
}));

app.delete("/lessons/:id", auth, wrap(async (req, res) => {
  await db.query(
    "DELETE FROM lessons WHERE id=$1",
    [parseInt(req.params.id) || 0]
  );
  res.json({ ok: true });
}));

/* AI CODE GENERATION */

app.post("/code", auth, wrap(async (req, res) => {
  const ask = String(req.body.prompt || "").slice(0, 2000);
  if (!ask.trim()) {
    return res.status(400).json({ error: "Prompt is empty" });
  }

  const sys = SYS.code + await context(req.body.project || "main", ask);
  const draft = await groq(sys, [{ role: "user", content: ask }], "high");

  const final = await groq(
    sys + "\nReview the code. Fix bugs, deprecated APIs and security holes. Return only final code.",
    [{ role: "user", content: `Task:\n${ask}\n\nDraft:\n${draft}` }],
    "high"
  );

  res.json({ code: final });
}));

/* MAP GENERATION AND PER-CHAT SAVE */

function cleanMap(raw) {
  const text = raw.replace(/```json|```/g, "").trim();
  const data = JSON.parse(text);

  if (!data || typeof data !== "object" || !Array.isArray(data.parts)) {
    throw new Error("Invalid map data");
  }

  const clamp = (v, low, high) =>
    Math.max(low, Math.min(high, Number(v) || 0));

  const vector = (values, defaults, low, high) => {
    const source = Array.isArray(values) ? values : defaults;
    return [0, 1, 2].map(i => clamp(source[i], low, high));
  };

  data.parts = data.parts.slice(0, 150).map(part => ({
    shape: ["Block", "Ball", "Cylinder", "Wedge"].includes(part.shape)
      ? part.shape
      : "Block",
    pos: vector(part.pos, [0, 2, 0], -45, 45),
    size: vector(part.size, [4, 2, 4], 1, 50),
    color: vector(part.color, [128, 128, 128], 0, 255),
    material: String(part.material || "Plastic").slice(0, 30)
  }));

  data.name = String(data.name || "Untitled Build").slice(0, 60);
  return data;
}

app.post("/map", auth, wrap(async (req, res) => {
  const ask = String(req.body.prompt || "").slice(0, 1000);

  if (!ask.trim()) {
    return res.status(400).json({ error: "Prompt is empty" });
  }

  const sys = SYS.map + await context(req.body.project || "main", ask);
  const raw = await groq(sys, [{ role: "user", content: ask }], "high");
  const map = cleanMap(raw);

  // Save only when the Roblox server supplies both identifiers.
  if (req.body.playerId && req.body.conversationId) {
    const owner = playerId(req.body.playerId);
    const id = chatId(req.body.conversationId);
    const conversation = await ownedConversation(id, owner);

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    await db.query(
      `INSERT INTO chat_builds
         (conversation_id, player_id, build_name, build_data, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (conversation_id)
       DO UPDATE SET
         player_id = EXCLUDED.player_id,
         build_name = EXCLUDED.build_name,
         build_data = EXCLUDED.build_data,
         updated_at = now()`,
      [id, owner, map.name, JSON.stringify(map)]
    );
  }

  res.json(map);
}));

/* AGENT SYSTEM */

require("./agents")(app, {
  groq,
  db,
  auth,
  wrap,
  context,
  addLesson
});

/* ERRORS */

app.use((err, req, res, next) => {
  console.error("Request error:", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Server error" });
});

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

/* START ONLY AFTER DATABASE TABLES EXIST */

async function start() {
  await ensureSchema();

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, "0.0.0.0", () => {
    console.log(`Roblox AI backend listening on port ${port}`);
  });
}

start().catch(error => {
  console.error("Backend startup failed:", error);
  process.exit(1);
});
              
