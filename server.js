const express = require("express");
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("ok"));

app.post("/chat", async (req, res) => {
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: "You are a friendly NPC in a Roblox game. Keep replies under 2 sentences." },
          { role: "user", content: String(req.body.message || "").slice(0, 500) },
        ],
      }),
    });
    const data = await r.json();
    res.json({ reply: data.choices?.[0]?.message?.content || "..." });
  } catch (e) {
    res.status(500).json({ reply: "Error" });
  }
});

app.listen(process.env.PORT || 3000);
