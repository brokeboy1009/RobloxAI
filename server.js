const express = require("express");
const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  if (req.get("x-game-secret") !== process.env.GAME_SECRET) {
    return res.sendStatus(401);
  }
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.GROQ_API_KEY,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: req.body.messages,
      max_completion_tokens: 400,
      reasoning_effort: "low",
    }),
  });
  res.status(r.status).json(await r.json());
});

app.listen(process.env.PORT || 3000);
