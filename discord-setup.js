// Builds the Discord server once. Open /setup-discord?code=YOUR_ACCESS_CODE in a browser.
const API = "https://discord.com/api/v10";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(token, method, path, body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(API + path, {
      method,
      headers: {
        Authorization: "Bot " + token,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://robloxai-8j31.onrender.com, 1.0)",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    if (r.status === 429) {
      await sleep(((data && data.retry_after) || 1) * 1000 + 100);
      continue;
    }
    if (!r.ok) {
      const err = new Error(method + " " + path + " " + r.status + " " + ((data && data.message) || text).slice(0, 120));
      err.status = r.status;
      throw err;
    }
    await sleep(350);
    return data;
  }
  throw new Error("Discord rate limit, try again in a minute");
}

async function build(token) {
  const log = [];
  const guilds = await call(token, "GET", "/users/@me/guilds");
  if (!guilds.length) throw new Error("Nova is not in any server yet. Use the invite link first.");
  const gid = guilds[0].id;
  const info = await call(token, "GET", "/guilds/" + gid);
  log.push("Building in: " + info.name);

  const role = (name, permissions, color) =>
    call(token, "POST", "/guilds/" + gid + "/roles", { name, permissions, color, hoist: name !== "Member" });
  const owner = await role("Owner", "8", 0xd97757);
  await role("Mod", String(2 + 4 + 8192), 0x5865f2);
  await role("Member", "0", 0x99aab5);
  await call(token, "PUT", "/guilds/" + gid + "/members/" + info.owner_id + "/roles/" + owner.id);
  log.push("Roles made: Owner, Mod, Member (Owner given to you)");

  const VIEW = "1024";
  const SEND = "2048";
  const readOnly = [{ id: gid, type: 0, allow: "0", deny: SEND }];
  const staffOnly = [
    { id: gid, type: 0, allow: "0", deny: VIEW },
    { id: owner.id, type: 0, allow: VIEW, deny: "0" },
  ];

  const make = async (name, type, parent, overwrites) => {
    const body = { name, type };
    if (parent) body.parent_id = parent;
    if (overwrites) body.permission_overwrites = overwrites;
    try {
      return await call(token, "POST", "/guilds/" + gid + "/channels", body);
    } catch (e) {
      // announcement and forum channels need Community mode, so fall back to text
      if ((type === 5 || type === 15) && e.status === 400) {
        body.type = 0;
        log.push(name + " made as a text channel (turn on Community to make it " + (type === 5 ? "an announcement" : "a forum") + " channel)");
        return await call(token, "POST", "/guilds/" + gid + "/channels", body);
      }
      throw e;
    }
  };

  const ch = {};
  let cat = await make("START HERE", 4);
  ch.welcome = await make("👋｜welcome", 0, cat.id, readOnly);
  ch.rules = await make("📜｜rules", 0, cat.id, readOnly);
  await make("📢｜announcements", 5, cat.id, readOnly);

  cat = await make("COMMUNITY", 4);
  await make("💬｜general", 0, cat.id);
  ch.showcase = await make("🖼️｜showcase", 15, cat.id);
  ch.ideas = await make("💡｜ideas", 15, cat.id);

  cat = await make("SUPPORT", 4);
  await make("🐞｜bug-reports", 15, cat.id);
  ch.appeals = await make("⚖️｜ban-appeals", 0, cat.id);

  cat = await make("STAFF", 4, null, staffOnly);
  await make("🔎｜appeal-review", 0, cat.id, staffOnly);
  log.push("Categories and channels made");

  const say = (id, content) => call(token, "POST", "/channels/" + id + "/messages", { content });
  await say(ch.welcome.id,
    "**Welcome!** 👋\nThis is the community for our Roblox AI game builder. Describe what you want and the AI builds it.\n\n" +
    "📜 Read <#" + ch.rules.id + ">\n🖼️ Show your builds in <#" + ch.showcase.id + ">\n💡 Share ideas in <#" + ch.ideas.id + ">\n⚖️ Banned by mistake? Use <#" + ch.appeals.id + ">");
  await say(ch.rules.id,
    "**Rules**\n1. Be respectful and keep everything family friendly.\n2. Don't try to get secrets from the AI or break its rules.\n" +
    "3. Strikes: 1st is a kick, 2nd is a 5 day ban, 3rd is a permanent ban.\n4. Banned by mistake? Post in <#" + ch.appeals.id + ">.\n5. Follow Discord's Terms of Service.");
  await say(ch.appeals.id,
    "**Ban appeal**\nPost these three things:\n1. Your Roblox username\n2. What you typed to the AI\n3. Why you think it was a mistake");
  log.push("Welcome, rules and appeal messages posted");
  log.push("Done! Now remove Nova's Administrator permission and reset its token in the Developer Portal.");
  return log;
}

module.exports = function (app) {
  let ran = false;
  app.get("/setup-discord", async (req, res) => {
    res.type("text/plain");
    if (!process.env.ACCESS_CODE || req.query.code !== process.env.ACCESS_CODE) return res.status(401).send("bad code");
    if (!process.env.DISCORD_TOKEN) return res.status(500).send("DISCORD_TOKEN is not set in Render");
    if (ran) return res.send("Already ran. Restart the service to run it again.");
    ran = true;
    try {
      res.send((await build(process.env.DISCORD_TOKEN)).join("\n"));
    } catch (e) {
      ran = false;
      res.status(500).send("Failed: " + e.message);
    }
  });
};
