const express = require("express");
const app = express();
app.use(express.json());

const SYSTEM = `You design Roblox game objects. Reply with JSON only, shaped like:
{"parts":[{"shape":"Block|Ball|Cylinder","size":[x,y,z],"position":[x,y,z],"color":"#RRGGBB","behavior":"none|lava|bounce|coin"}]}
Use at most 40 parts. Sizes and positions are in studs. y=0 is the ground.`;

const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<h3>Game AI</h3>
<input id=code placeholder="access code"><br>
<textarea id=msg rows=4 style="width:100%" placeholder="Describe what to build"></textarea>
<button onclick=go()>Build</button><pre id=out></pre>
<script>
async function go(){
  out.textContent="Thinking...";
  const r=await fetch("/build",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({code:code.value,message:msg.value})});
  out.textContent=JSON.stringify(await r.json(),null,2);
}
</script>`;

let latest = { parts: [] };

app.get("/", (req, res) => res.send(PAGE));

app.post("/build", async (req, res) => {
  if (req.body.code !== process.env.ACCESS_CODE) {
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
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: req.body.message },
        ],
      }),
    });
    const data = await r.json();
    latest = JSON.parse(data.choices[0].message.content);
    res.json(latest);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// The Roblox game will read this
app.get("/latest", (req, res) => res.json(latest));

app.listen(process.env.PORT ||
              3000);
