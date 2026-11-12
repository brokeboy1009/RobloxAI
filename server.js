"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const {
  chat,
  generateCode,
  buildMap,
  improveMap,
  generateIdeas,
  reviewWorkspace,
  moderateContent,
  redactSecrets
} = require("./agents");

const app = express();
const PORT = process.env.PORT || 10000;
const APP_TOKEN = process.env.APP_TOKEN || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

if (!APP_TOKEN || APP_TOKEN.length < 32) {
  throw new Error("APP_TOKEN must be set to a strong secret of at least 32 characters.");
}

if (!GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is missing.");
}

const ENCRYPTION_KEY = crypto
  .createHash("sha256")
  .update(APP_TOKEN + "|RobloxAI-player-key-encryption-v1")
  .digest();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use("/api", rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

function clean(value, max = 12000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function checkAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";

  const a = Buffer.from(supplied);
  const b = Buffer.from(APP_TOKEN);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function safeOutput(value) {
  try {
    return redactSecrets(value);
  } catch {
    return value;
  }
}

function moderate(input) {
  try {
    const result = moderateContent(input);
    if (result === false) return false;
    if (result && typeof result === "object") {
      if (result.allowed === false || result.blocked === true) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function encryptPlayerKey(apiKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);

  const encrypted = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final()
  ]);

  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  };
}

function decryptPlayerKey(blob) {
  if (!blob || blob.version !== 1) {
    throw new Error("Invalid saved credential.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    ENCRYPTION_KEY,
    Buffer.from(blob.iv, "base64")
  );

  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

async function runAgent(agent, input) {
  if (typeof agent !== "function") {
    throw new Error("AI agent is not configured.");
  }

  const result = await agent(input);

  if (result === undefined || result === null) {
    throw new Error("The AI returned an empty response.");
  }

  return safeOutput(result);
}

app.get("/", (req, res) => {
  res.json({
    service: "RobloxAI",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "roblox-ai-game-creator"
  });
});

app.post("/api/credentials/encrypt", checkAuth, (req, res) => {
  try {
    const body = req.body || {};
    const userId = clean(String(body.userId || ""), 30);
    const apiKey = clean(body.apiKey, 1000);

    if (!/^[0-9]+$/.test(userId)) {
      return res.status(400).json({ error: "Invalid player ID." });
    }

    if (apiKey.length < 20 || apiKey.length > 1000) {
      return res.status(400).json({ error: "Invalid API key." });
    }

    const encrypted = encryptPlayerKey(apiKey);

    res.json({
      success: true,
      userId,
      credential: encrypted
    });
  } catch (error) {
    console.error("Credential encryption failed:", error.message);
    res.status(500).json({ error: "Could not save credential." });
  }
});

app.post("/api/chat", checkAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const message = clean(body.message);

    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    if (!moderate(message)) {
      return res.status(400).json({ error: "This request cannot be processed." });
    }

    const result = await runAgent(chat, {
      message,
      history: Array.isArray(body.history) ? body.history.slice(-20) : [],
      context: clean(body.context)
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(500).json({ error: "Chat request failed." });
  }
});

app.post("/api/generate", checkAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = clean(body.prompt);

    if (!prompt) {
      return res.status(400).json({ error: "A prompt is required." });
    }

    if (!moderate(prompt)) {
      return res.status(400).json({ error: "This request cannot be processed." });
    }

    const result = await runAgent(generateCode, {
      prompt,
      context: clean(body.context),
      workspace: body.workspace || null
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error("Generate error:", error.message);
    res.status(500).json({ error: "Code generation failed." });
  }
});

app.post("/api/build", checkAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = clean(body.prompt);

    if (!prompt) {
      return res.status(400).json({ error: "A build prompt is required." });
    }

    if (!moderate(prompt)) {
      return res.status(400).json({ error: "This request cannot be processed." });
    }

    const result = await runAgent(buildMap, {
      prompt,
      workspace: body.workspace || null,
      context: clean(body.context)
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error("Build error:", error.message);
    res.status(500).json({ error: "Build request failed." });
  }
});

app.post("/api/improve", checkAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = clean(body.prompt);

    if (!prompt) {
      return res.status(400).json({ error: "An improvement prompt is required." });
    }

    if (!moderate(prompt)) {
      return res.status(400).json({ error: "This request cannot be processed." });
    }

    const result = await runAgent(improveMap, {
      prompt,
      workspace: body.workspace || null,
      context: clean(body.context)
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error("Improve error:", error.message);
    res.status(500).json({ error: "Improvement failed." });
  }
});

app.post("/api/undo", checkAuth, (req, res) => {
  const body = req.body || {};

  if (!body.previousWorkspace) {
    return res.status(400).json({ error: "Previous workspace data is required." });
  }

  res.json({
    success: true,
    workspace: safeOutput(body.previousWorkspace)
  });
});

app.post("/api/ideas", checkAuth, async (req, res) => {
  try {
    const body = req.body || {};

    const result = await runAgent(generateIdeas, {
      prompt: clean(body.prompt, 5000),
      context: clean(body.context)
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error("Ideas error:", error.message);
    res.status(500).json({ error: "Idea generation failed." });
  }
});

app.post("/api/review", checkAuth, async (req, res) => {
  try {
    const body = req.body || {};

    if (!body.workspace) {
      return res.status(400).json({ error: "Workspace data is required." });
    }

    const result = await runAgent(reviewWorkspace, {
      workspace: body.workspace,
      context: clean(body.context)
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error("Review error:", error.message);
    res.status(500).json({ error: "Workspace review failed." });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Not found",
    path: req.path
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("RobloxAI server running on port " + PORT);
});
