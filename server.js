"use strict";

const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false
}));

const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.MODEL || "openai/gpt-oss-120b";
const TOKEN = process.env.APP_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT) || 10000;

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: /render\.com/i.test(DATABASE_URL || "")
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const SYS = {
  chat: `You are a helpful, friendly assistant inside a Roblox game creator.
Answer normal questions normally. Do not create code or build maps unless explicitly requested.
Never claim you changed the Roblox Workspace. Keep answers clear and concise.`,

  code: `You are an expert Roblox Luau developer.
Return working Luau code with short comments.
Validate all RemoteEvent input on the server.
Never trust the client. Never expose credentials, tokens, passwords, or private environment values.
Do not write malware, credential theft, unauthorized access, or destructive attacks.`,

  map: `You are a Roblox map designer.
Return ONLY valid JSON in this format:
{"name":"Build name","parts":[{"shape":"Block","pos":[0,2,0],"size":[4,2,4],"color":[120,120,120],"material":"Plastic"}]}
Allowed shapes: Block, Ball, Cylinder, Wedge.
Maximum 150 parts. Positions must stay between -45 and 45.
Sizes must stay between 1 and 50.
Colors must be RGB values from 0 to 255.
Do not include scripts, commands, or executable code.`
};

function same(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* SECRET PROTECTION */

function redactSecrets(input) {
  let value = String(input ?? "");

  const knownSecrets = [
    KEY,
    TOKEN,
    DATABASE_URL,
    process.env.GITHUB_TOKEN
  ].filter(v => typeof v === "string" && v.length >= 8);

  for (const secret of knownSecrets) {
    value = value.split(secret).join("[REDACTED]");
  }

  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bgsk_[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(
      /((?:api[_-]?key|app[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie|database[_-]?url)\s*[=:]\s*)(["']?)[^\s"',;]+\2/gi,
      "$1[REDACTED]"
    );
}

/* MODERATION
   This checks only clear credential-theft and unauthorized-attack requests.
   It is not a general keyword filter.
*/

function detectViolation(input) {
  const value = String(input || "").trim();
  if (!value) return null;

  const defensive = /\b(protect|secure|defend|prevent|patch|fix|audit|scan|recover|authorized test|my own server|my own game)\b/i;

  if (defensive.test(value)) return null;

  const rules = [
    {
      category: "credential theft",
      pattern: /\b(steal|exfiltrate|harvest|dump|extract)\b.{0,70}\b(passwords?|api keys?|bearer tokens?|cookies?|session ids?|credentials?)\b/i
    },
    {
      category: "unauthorized access",
      pattern: /\b(break into|hack into|bypass authentication|steal access)\b.{0,70}\b(render|github|groq|database|server|account)\b/i
    },
    {
      category: "malicious software",
      pattern: /\b(create|write|deploy)\b.{0,50}\b(keylogger|credential stealer|password stealer|ransomware)\b/i
    },
    {
      category: "service attack",
      pattern: /\b(ddos|denial.of.service)\b.{0,50}\b(server|website|game|service)\b/i
    }
  ];

  for (const rule of rules) {
    if (rule.pattern.test(value)) return rule.category;
  }

  return null;
}

function wrap(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

function playerId(value) {
  const id = String(value || "");
  if (!/^\d{1,20}$/.test(id)) {
    const error = new Error("Invalid player ID");
    error.status = 400;
    throw error;
  }
  return id;
}

function chatId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error("Invalid conversation ID");
    error.status = 400;
    throw error;
  }
  return id;
}

async function moderate(owner, submitted, req) {
  const status = await db.query(
    `SELECT strike_count, banned_until, permanent_ban
     FROM player_moderation WHERE player_id=$1`,
    [owner]
  );

  const current = status.rows[0];

  if (
    current?.permanent_ban ||
    (current?.banned_until && new Date(current.banned_until) > new Date())
  ) {
    return {
      blocked: true,
      banned: true,
      permanent: Boolean(current.permanent_ban),
      strikes: Number(current.strike_count || 0),
      bannedUntil: current.banned_until || null
    };
  }

  const category = detectViolation(submitted);
  if (!category) return { blocked: false };

  // Delete only the exact triggering message, if it was already saved.
  const id = Number(req.params?.id);

  if (
    Number.isSafeInteger(id) &&
    id > 0 &&
    typeof req.body?.content === "string"
  ) {
    await db.query(
      `DELETE FROM conversation_messages
       WHERE id = (
         SELECT id FROM conversation_messages
         WHERE conversation_id=$1
           AND player_id=$2
           AND role='user'
           AND content=$3
         ORDER BY id DESC LIMIT 1
       )`,
      [id, owner, req.body.content]
    );
  }

  const result = await db.query(
    `INSERT INTO player_moderation
       (player_id, strike_count, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (player_id)
     DO UPDATE SET
       strike_count = player_moderation.strike_count + 1,
       updated_at = now()
     RETURNING strike_count`,
    [owner]
  );

  const strikes = Number(result.rows[0].strike_count);
  const permanent = strikes >= 4;
  const oneDay = strikes === 3;

  await db.query(
    `UPDATE player_moderation
     SET permanent_ban=$2,
         banned_until=CASE
           WHEN $3 THEN now() + interval '1 day'
           WHEN $2 THEN NULL
           ELSE banned_until
         END,
         updated_at=now()
     WHERE player_id=$1`,
    [owner, permanent, oneDay]
  );

  await db.query(
    `INSERT INTO moderation_events
       (player_id, strike_number, category)
     VALUES ($1,$2,$3)`,
    [owner, strikes, category]
  );

  return {
    blocked: true,
    banned: oneDay || permanent,
    permanent,
    strikes,
    category
  };
}

/* AUTHENTICATION */

const auth = async (req, res, next) => {
  if (!TOKEN || !same(req.get("x-token"), TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const appealRoute =
      req.path === "/moderation/appeal" ||
      req.path === "/moderation/status";

    const ownerValue =
      req.body?.playerId || req.query?.playerId || "";

    if (!appealRoute && /^\d{1,20}$/.test(String(ownerValue))) {
      const owner = String(ownerValue);

      const submitted =
        req.body?.message ||
        req.body?.prompt ||
        req.body?.request ||
        (req.body?.role === "user" ? req.body?.content : "");

      const result = await moderate(owner, submitted, req);

      if (result.blocked) {
        return res.status(403).json({
          error: result.permanent
            ? "Permanent ban applied"
            : result.banned
              ? "One-day ban applied"
              : "Request blocked by moderation",
          kick: true,
          banned: result.banned,
          permanent: result.permanent,
          strikes: result.strikes,
          category: result.category || "account restriction",
          messageDeleted: true
        });
      }
    }

    next();
  } catch (_) {
    return res.status(503).json({
      error: "Security check temporarily unavailable"
    });
  }
};

/* DATABASE */

async function ensureSchema() {
  await db.query(`
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
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS conversation_messages_history
      ON conversation_messages(conversation_id, player_id, id);

    CREATE TABLE IF NOT EXISTS chat_builds (
      conversation_id BIGINT PRIMARY KEY
        REFERENCES conversations(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      build_name TEXT NOT NULL DEFAULT 'Untitled Build',
      build_data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS build_versions (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      build_name TEXT NOT NULL,
      build_data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS build_versions_history
      ON build_versions(conversation_id, player_id, id DESC);

    CREATE TABLE IF NOT EXISTS player_moderation (
      player_id TEXT PRIMARY KEY,
      strike_count INT NOT NULL DEFAULT 0,
      banned_until TIMESTAMPTZ,
      permanent_ban BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS moderation_events (
      id BIGSERIAL PRIMARY KEY,
      player_id TEXT NOT NULL,
      strike_number INT NOT NULL,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS moderation_appeals (
      id BIGSERIAL PRIMARY KEY,
      player_id TEXT NOT NULL,
      appeal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS builds (
      id SERIAL PRIMARY KEY,
      player_id TEXT,
      project TEXT,
      request TEXT,
      plan JSONB,
      scripts JSONB,
      report TEXT,
      parent_id INT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    ALTER TABLE builds ADD COLUMN IF NOT EXISTS player_id TEXT;
    ALTER TABLE builds ADD COLUMN IF NOT EXISTS parent_id INT;
  `);

  console.log("Database schema ready");
}

/* GROQ */

async function groq(system, messages, effort = "medium") {
  if (!KEY) throw new Error("AI service unavailable");

  const safeMessages = messages.map(message => ({
    role: message.role,
    content: redactSecrets(message.content)
  }));

  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: redactSecrets(system) },
      ...safeMessages
    ]
  };

  if (MODEL.includes("gpt-oss")) {
    body.reasoning_effort = effort;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(
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

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error("AI provider request failed");
      }

      const reply = data.choices?.[0]?.message?.content;
      if (!reply) throw new Error("Empty AI response");

      return redactSecrets(reply);
    } catch (_) {
      console.error("AI request failed; details withheld.");

      if (attempt === 2) {
        throw new Error("AI service temporarily unavailable");
      }

      await new Promise(resolve =>
        setTimeout(resolve, 1200 * (attempt + 1))
      );
    }
  }

  throw new Error("AI service unavailable");
}

/* HELPERS */

async function ownedConversation(id, owner) {
  const result = await db.query(
    `SELECT id, player_id, title
     FROM conversations
     WHERE id=$1 AND player_id=$2`,
    [id, owner]
  );

  return result.rows[0] || null;
}

function cleanMap(raw) {
  const text = String(raw)
    .replace(/```json|```/gi, "")
    .trim();

  const data = JSON.parse(text);

  if (!data || !Array.isArray(data.parts)) {
    throw new Error("Invalid map response");
  }

  const clamp = (value, min, max) =>
    Math.max(min, Math.min(max, Number(value) || 0));

  const vector = (values, fallback, min, max) => {
    const source = Array.isArray(values) ? values : fallback;
    return [0, 1, 2].map(i => clamp(source[i], min, max));
  };

  const parts = data.parts.slice(0, 150).map(part => ({
    shape: ["Block", "Ball", "Cylinder", "Wedge"].includes(part.shape)
      ? part.shape
      : "Block",
    pos: vector(part.pos, [0, 2, 0], -45, 45),
    size: vector(part.size, [4, 2, 4], 1, 50),
    color: vector(part.color, [128, 128, 128], 0, 255),
    material: String(part.material || "Plastic").slice(0, 30)
  }));

  return {
    name: redactSecrets(String(data.name || "Untitled Build").slice(0, 60)),
    parts
  };
}

async function saveBuild(id, owner, map) {
  const previous = await db.query(
    `SELECT build_name, build_data
     FROM chat_builds
     WHERE conversation_id=$1 AND player_id=$2`,
    [id, owner]
  );

  if (previous.rows[0]) {
    await db.query(
      `INSERT INTO build_versions
         (conversation_id, player_id, build_name, build_data)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [
        id,
        owner,
        previous.rows[0].build_name,
        JSON.stringify(previous.rows[0].build_data)
      ]
    );

    await db.query(
      `DELETE FROM build_versions
       WHERE id IN (
         SELECT id FROM build_versions
         WHERE conversation_id=$1 AND player_id=$2
         ORDER BY id DESC OFFSET 20
       )`,
      [id, owner]
    );
  }

  await db.query(
    `INSERT INTO chat_builds
       (conversation_id, player_id, build_name, build_data, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,now())
     ON CONFLICT (conversation_id)
     DO UPDATE SET
       player_id=EXCLUDED.player_id,
       build_name=EXCLUDED.build_name,
       build_data=EXCLUDED.build_data,
       updated_at=now()`,
    [id, owner, map.name, JSON.stringify(map)]
  );
}

/* HEALTH */

app.get("/", (req, res) => {
  res.send("Roblox AI Game Creator backend is running.");
});

app.get("/health", wrap(async (req, res) => {
  await db.query("SELECT 1");
  res.json({ ok: true, database: "connected", model: MODEL });
}));

/* CONVERSATIONS */

app.get("/conversations", auth, wrap(async (req, res) => {
  const owner = playerId(req.query.playerId);

  const result = await db.query(
    `SELECT id,title,created_at,updated_at
     FROM conversations
     WHERE player_id=$1
     ORDER BY updated_at DESC LIMIT 100`,
    [owner]
  );

  res.json({ conversations: result.rows });
}));

app.post("/conversations", auth, wrap(async (req, res) => {
  const owner = playerId(req.body.playerId);
  const title = redactSecrets(
    String(req.body.title || "New Chat").slice(0, 80)
  );

  const result = await db.query(
    `INSERT INTO conversations(player_id,title)
     VALUES ($1,$2)
     RETURNING id,title,created_at,updated_at`,
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

  if (!await ownedConversation(id, owner)) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const result = await db.query(
    `SELECT id,role,content,created_at
     FROM conversation_messages
     WHERE conversation_id=$1 AND player_id=$2
     ORDER BY id ASC LIMIT 500`,
    [id, owner]
  );

  res.json({
    messages: result.rows.map(row => ({
      ...row,
      content: redactSecrets(row.content)
    }))
  });
}));

app.post("/conversations/:id/messages", auth, wrap(async (req, res) => {
  const owner = playerId(req.body.playerId);
  const id = chatId(req.params.id);
  const role = String(req.body.role || "");
  const content = redactSecrets(
    String(req.body.content || "").slice(0, 14000)
  );

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
       (conversation_id,player_id,role,content)
     VALUES ($1,$2,$3,$4)
     RETURNING id,role,content,created_at`,
    [id, owner, role, content]
  );

  const title = role === "user" && conversation.title === "New Chat"
    ? content.slice(0, 60)
    : conversation.title;

  await db.query(
    `UPDATE conversations SET title=$1,updated_at=now()
     WHERE id=$2 AND player_id=$3`,
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
  const title = redactSecrets(
    String(req.body.title || "").trim().slice(0, 80)
  );

  if (!title) return res.status(400).json({ error: "Title required" });

  const result = await db.query(
    `UPDATE conversations SET title=$1,updated_at=now()
     WHERE id=$2 AND player_id=$3
     RETURNING id,title,updated_at`,
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
     WHERE id=$1 AND player_id=$2 RETURNING id`,
    [id, owner]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json({ ok: true });
}));

/* SAVED BUILD */

app.get("/conversations/:id/build", auth, wrap(async (req, res) => {
  const owner = playerId(req.query.playerId);
  const id = chatId(req.params.id);

  if (!await ownedConversation(id, owner)) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const result = await db.query(
    `SELECT build_name,build_data,updated_at
     FROM chat_builds
     WHERE conversation_id=$1 AND player_id=$2`,
    [id, owner]
  );

  res.json({ ok: true, build: result.rows[0] || null });
}));

app.post("/conversations/:id/undo", auth, wrap(async (req, res) => {
  const owner = playerId(req.body.playerId);
  const id = chatId(req.params.id);

  if (!await ownedConversation(id, owner)) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const previous = await db.q
