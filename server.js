const express = require("express");
const app = express();
app.use(express.json());

const SYSTEM = `You design Roblox game objects. Reply with JSON only, shaped like:
{"parts":[{"shape":"Block|Ball|Cylinder","size":[x,y,z],"position":[x,y,z],"color":"#RRGGBB","behavior":"none|lava|bounce|coin"}]}
Use at most 40 parts. Sizes and positions are in studs. y=0 is the ground.`;

let latest = { parts: [] };

// health check
app.get("/", (req, res) => res.send("ok"));

// Roblox calls this
app.post("/build", async (req, res) => {
  if (!process.env.ACCESS_CODE || req.body.code !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: "bad access code" });
  }
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: String(req.body.message || "") },
        ],
      }),
    });
    const data = await r.json();
    if (!data.choices) return res.status(502).json({ error: data });
    latest = JSON.parse(data.choices[0].message.content);
    res.json(latest);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/latest", (req, res) => res.json(latest));

app.listen(process.env.PORT || 
              3000);
