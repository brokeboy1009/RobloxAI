"use strict";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function redactSecrets(value) {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/\bgsk_[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^"' \n,}]+/gi, "$1=[REDACTED]");
  }

  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === "object") {
    const result = {};

    for (const [key, item] of Object.entries(value)) {
      if (/api[_-]?key|token|secret|password|authorization/i.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactSecrets(item);
      }
    }

    return result;
  }

  return value;
}

function moderateContent(input) {
  const text = typeof input === "string"
    ? input
    : JSON.stringify(input || "");

  const blockedPatterns = [
    /steal.{0,30}(password|token|key|cookie|credential)/i,
    /keylogger/i,
    /ransomware/i,
    /credential theft/i,
    /ddos/i,
    /steal.{0,30}(api|groq|render|roblox).{0,20}(key|token|secret)/i,
    /hack.{0,30}(render|roblox|server).{0,20}(account|access|password)/i,
    /bypass.{0,30}(authentication|login|security)/i
  ];

  return !blockedPatterns.some(pattern => pattern.test(text));
}

function toText(value, maxLength = 20000) {
  if (typeof value === "string") {
    return value.slice(0, maxLength);
  }

  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return "";
  }
}

function parseJson(text) {
  if (typeof text !== "string") {
    return text;
  }

  let cleaned = text.trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {}
    }

    throw new Error("The AI returned invalid JSON.");
  }
}

async function callGroq(systemPrompt, userPrompt, options = {}) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing from Render environment variables.");
  }

  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: userPrompt
    }
  ];

  const payload = {
    model: GROQ_MODEL,
    messages,
    temperature: options.temperature ?? 0.4,
    max_tokens: options.maxTokens ?? 6000
  };

  if (options.json) {
    payload.response_format = {
      type: "json_object"
    };
  }

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + GROQ_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Groq request failed:", response.status);

    throw new Error("The AI service request failed.");
  }

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("The AI returned an empty response.");
  }

  return options.json ? parseJson(content) : content;
}

async function chat(input) {
  const message = toText(input.message, 12000);

  const history = Array.isArray(input.history)
    ? input.history.slice(-20).map(item => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: toText(item.content || item.message, 4000)
      }))
    : [];

  const systemPrompt = `
You are RobloxAI, an assistant for creating Roblox games.

Help users with Roblox Studio, Luau scripts, game mechanics,
UI design, building ideas, debugging, and improving games.

Give accurate, practical answers.
Keep code compatible with Roblox Luau.
Never reveal API keys, passwords, tokens, or private server data.
Do not create exploit scripts, credential theft tools,
or code designed to attack servers or accounts.
`;

  return callGroq(
    systemPrompt,
    "Context:\n" + toText(input.context, 10000) +
    "\n\nConversation:\n" + JSON.stringify(history) +
    "\n\nUser:\n" + message,
    {
      maxTokens: 5000
    }
  );
               }async function generateCode(input) {
  const systemPrompt = `
You are RobloxAI's Roblox Luau code generator.

Generate clean, functional Roblox Luau code.
Use correct Roblox services and APIs.
Explain which scripts belong in ServerScriptService,
StarterPlayerScripts, StarterGui, or other locations.

Never generate exploit scripts, account theft,
credential theft, or server attack code.

Return the requested code and its required placement.
`;

  return callGroq(
    systemPrompt,
    "Request:\n" + toText(input.prompt, 12000) +
    "\n\nContext:\n" + toText(input.context, 10000) +
    "\n\nWorkspace:\n" + toText(input.workspace, 10000),
    {
      maxTokens: 7000
    }
  );
}

async function buildMap(input) {
  const systemPrompt = `
You are RobloxAI's map-building planner.

Convert the user's building request into structured JSON.
Return valid JSON only.

Use this structure:
{
  "success": true,
  "description": "Short description",
  "objects": [
    {
      "name": "PartName",
      "type": "Part",
      "position": [0, 0, 0],
      "size": [4, 1, 4],
      "color": [255, 255, 255],
      "material": "SmoothPlastic",
      "anchored": true
    }
  ]
}

Use reasonable Roblox dimensions.
Do not include scripts that attack accounts or servers.
`;

  return callGroq(
    systemPrompt,
    "Build request:\n" + toText(input.prompt, 12000) +
    "\n\nWorkspace:\n" + toText(input.workspace, 12000) +
    "\n\nContext:\n" + toText(input.context, 8000),
    {
      json: true,
      maxTokens: 7000
    }
  );
}

async function improveMap(input) {
  const systemPrompt = `
You are RobloxAI's map improvement assistant.

Analyze the supplied Roblox workspace information.
Suggest or generate improvements based on the user's request.
Return valid JSON only.

Use this structure:
{
  "success": true,
  "description": "What changed",
  "objects": [],
  "remove": []
}

Never remove unrelated objects.
Do not create destructive or malicious scripts.
`;

  return callGroq(
    systemPrompt,
    "Improvement request:\n" + toText(input.prompt, 12000) +
    "\n\nWorkspace:\n" + toText(input.workspace, 15000) +
    "\n\nContext:\n" + toText(input.context, 8000),
    {
      json: true,
      maxTokens: 7000
    }
  );
}

async function generateIdeas(input) {
  const systemPrompt = `
You are RobloxAI's game idea generator.

Generate creative Roblox game ideas.
Include gameplay mechanics, objectives, features,
and suggestions for building the game.

Return valid JSON only.

Use this structure:
{
  "ideas": [
    {
      "name": "Game name",
      "description": "Game description",
      "features": [],
      "mechanics": []
    }
  ]
}
`;

  return callGroq(
    systemPrompt,
    "Generate ideas for:\n" + toText(input.prompt, 5000) +
    "\n\nContext:\n" + toText(input.context, 8000),
    {
      json: true,
      maxTokens: 5000
    }
  );
}

async function reviewWorkspace(input) {
  const systemPrompt = `
You are RobloxAI's Roblox workspace reviewer.

Review the supplied workspace information.
Find possible problems, missing objects,
organization issues, and improvement opportunities.

Return valid JSON only.

Use this structure:
{
  "success": true,
  "summary": "Review summary",
  "problems": [],
  "suggestions": [],
  "warnings": []
}
`;

  return callGroq(
    systemPrompt,
    "Workspace:\n" + toText(input.workspace, 15000) +
    "\n\nContext:\n" + toText(input.context, 8000),
    {
      json: true,
      maxTokens: 5000
    }
  );
}

module.exports = {
  chat,
  generateCode,
  buildMap,
  improveMap,
  generateIdeas,
  reviewWorkspace,
  moderateContent,
  redactSecrets
};
