"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

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

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait a moment."
  }
}));

function clean(value, maxLength = 12000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function getBody(req) {
  return req.body && typeof req.body === "object"
    ? req.body
    : {};
}

function checkAuth(req, res, next) {
  if (!APP_TOKEN) return next();

  const authorization = req.headers.authorization || "";
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (suppliedToken !== APP_TOKEN) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

function safeOutput(value) {
  try {
    const result = redactSecrets(value);
    return result === undefined ? value : result;
  } catch {
    return value;
  }
}

function moderate(input) {
  try {
    const result = moderateContent(input);

    if (result === false) return false;

    if (result && typeof result === "object") {
      if (result.allowed === false || result.blocked === true) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

async function runAgent(agent, input) {
  if (typeof agent !== "function") {
    throw new Error("AI agent is not configured correctly.");
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
    status: "online",
    endpoints: [
      "/health",
      "/api/chat",
      "/api/generate",
      "/api/build",
      "/api/improve",
      "/api/undo",
      "/api/ideas",
      "/api/review"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "roblox-ai-game-creator",
    status: "online"
  });
});

app.post("/api/chat", checkAuth, async (req, res) => {
  try {
    const body = getBody(req);
    const message = clean(body.message, 12000);

    if (!message) {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    if (!moderate(message)) {
      return res.status(400).json({
        error: "This request cannot be processed."
      });
    }

    const history = Array.isArray(body.history)
      ? body.history.slice(-20)
      : [];

    const result = await runAgent(chat, {
      message,
      history,
      context: clean(body.context, 12000)
    });

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error("Chat error:", error.message);

    res.status(500).json({
      error: "Chat request failed."
    });
  }
});

app.post("/api/generate", checkAuth, async (req, res) => {
  try {
    const body = getBody(req);
    const prompt = clean(body.prompt, 12000);

    if (!prompt) {
      return res.status(400).json({
        error: "A generation prompt is required."
      });
    }

    if (!moderate(prompt)) {
      return res.status(400).json({
        error: "This request cannot be processed."
      });
    }

    const result = await runAgent(generateCode, {
      prompt,
      context: clean(body.context, 10000),
      workspace: body.workspace || null
    });

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error("Generate error:", error.message);

    res.status(500).json({
      error: "Code generation failed."
    });
  }
});

app.post("/api/build", checkAuth, async (req, res) => {
  try {
    const body = getBody(req);
    const prompt = clean(body.prompt, 12000);

    if (!prompt) {
      return res.status(400).json({
        error: "A build prompt is required."
      });
    }

    if (!moderate(prompt)) {
      return res.status(400).json({
        error: "This request cannot be processed."
      });
    }

    const result = await runAgent(buildMap, {
      prompt,
      workspace: body.workspace || null,
      context: clean(body.context, 12000)
    });

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error("Build error:", error.message);

    res.status(500).json({
      error: "Build request failed."
    });
  }
});app.post("/api/improve", checkAuth, async (req, res) => {
  try {
    const body = getBody(req);
    const prompt = clean(body.prompt, 12000);

    if (!prompt) {
      return res.status(400).json({
        error: "An improvement prompt is required."
      });
    }

    if (!moderate(prompt)) {
      return res.status(400).json({
        error: "This request cannot be processed."
      });
    }

    const result = await runAgent(improveMap, {
      prompt,
      workspace: body.workspace || null,
      context: clean(body.context, 12000)
    });

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error("Improve error:", error.message);

    res.status(500).json({
      error: "Improvement failed."
    });
  }
});

app.post("/api/undo", checkAuth, (req, res) => {
  try {
    const body = getBody(req);

    if (!body.previousWorkspace) {
      return res.status(400).json({
        error: "Previous workspace data is required."
      });
    }

    res.json({
      success: true,
      workspace: safeOutput(body.previousWorkspace)
    });
  } catch (error) {
    console.error("Undo error:", error.message);

    res.status(500).json({
      error: "Undo failed."
    });
  }
});

app.post("/api/ideas", checkAuth, async (req, res) => {
  try {
    const body = getBody(req);

    const result = await runAgent(generateIdeas, {
      prompt: clean(body.prompt, 5000),
      context: clean(body.context, 10000)
    });

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error("Ideas error:", error.message);

    res.status(500).json({
      error: "Idea generation failed."
    });
  }
});

app.post("/api/review", checkAuth, async (req, res) => {
  try {
    const body = getBody(req);

    if (!body.workspace) {
      return res.status(400).json({
        error: "Workspace data is required."
      });
    }

    const result = await runAgent(reviewWorkspace, {
      workspace: body.workspace,
      context: clean(body.context, 10000)
    });

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error("Review error:", error.message);

    res.status(500).json({
      error: "Workspace review failed."
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Not found",
    path: req.path
  });
});

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "Internal server error."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("RobloxAI server running on port " + PORT);
});
