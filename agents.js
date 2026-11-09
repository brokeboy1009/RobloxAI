module.exports = (app, { groq, db, auth, wrap, context, addLesson }) => {
  db.query(`CREATE TABLE IF NOT EXISTS builds (id SERIAL PRIMARY KEY, project TEXT, request TEXT, plan JSONB, scripts JSONB, report TEXT, created_at TIMESTAMPTZ DEFAULT now())`)
    .then(() => db.query("ALTER TABLE builds ADD COLUMN IF NOT EXISTS parent_id INT"))
    .catch(console.error);

  const ask = async (sys, user, effort) => {
    const out = await groq(sys, [{ role: "user", content: user }], effort);
    if (!out) throw new Error("empty AI reply");
    return out;
  };
  const askJSON = async (sys, user, effort) => {
    for (let i = 0; i < 2; i++) {
      try { return JSON.parse((await ask(sys, user, effort)).replace(/```json|```/g, "").trim()); }
      catch (e) { if (i) throw e; }
    }
  };
  const stripCode = (s) => s.replace(/```luau|```lua|```/g, "").trim();
  const parseReview = (raw, fallback) => {
    const [issues, code] = raw.split("---CODE---");
    return { issues: (issues || "").replace(/^ISSUES:/i, "").trim(), code: stripCode(code || fallback) };
  };
  const bundle = (list) =>
    list.map((s) => `-- ${s.name} (${s.type} in ${s.location})\n${s.code}`).join("\n\n");

  const PLAN = `You are the Planner of a Roblox game-dev team. Understand what the person really means even if the request is vague. If an existing build is provided, modify it and keep what already works. Reply ONLY JSON: {"goal":string,"assumptions":[string],"risks":[string],"approaches":[{"name":string,"pros":string,"cons":string}],"chosen":string,"contracts":{"remotes":[string],"modules":[string],"notes":string},"systems":[{"name":string,"type":"Script|LocalScript|ModuleScript","location":string,"purpose":string}]}. Max 5 systems. Compare 2 approaches before choosing. Contracts are exact names shared between scripts.`;
  const CODER = `You are the Coder. Write ONE Roblox Luau script for your assigned system. Follow the plan contracts exactly (same RemoteEvent and module names). The server owns all important logic, validate all client input, use task.wait, cache services, no deprecated APIs. Output only code with short comments.`;
  const REVIEW = `You are the Reviewer. Check the script for bugs, nil errors, deprecated APIs, client-trust security holes, memory leaks, slow loops, and mismatch with the plan contracts. Reply exactly:\nISSUES:\n- severity (high/med/low): problem\n---CODE---\nthe full fixed code. If there are no issues write "- none".`;
  const INTEGRATE = `You are the Integrator. Check that these scripts work together: matching RemoteEvent names, require paths, missing dependencies or services, load-order problems. Reply OK, or a short bullet list of problems with a fix for each.`;
  const FIX = `You are a Luau fixer. Given integration problems and all scripts, fix ONLY the named script so everything works together. If it needs no change, return it unchanged. Output only the full code.`;
  const IMPROVE = `You are a refactoring engineer. Preserve ALL existing behavior, function names and RemoteEvent names. Find bugs, inefficiencies and deprecated APIs and fix them. Reply exactly:\nISSUES:\n- what you changed and why\n---CODE---\nthe full improved code.`;

  app.post("/build", auth, async (req, res) => {
    try {
      const project = String(req.body.project || "main");
      const request = String(req.body.request || "").slice(0, 3000);
      const autofix = req.body.autofix !== false;
      const parent = parseInt(req.body.basedOn) || null;

      let base = "";
      if (parent) {
        const b = await db.query("SELECT scripts FROM builds WHERE id=$1", [parent]);
        if (b.rows[0]) base = "\n\nExisting build to modify (keep what works):\n" + JSON.stringify(b.rows[0].scripts).slice(0, 20000);
      }

      const ctx = await context(project, request);
      const plan = await askJSON(PLAN + ctx, request + base, "high");
      const systems = (plan.systems || []).slice(0, 5);
      if (!systems.length) return res.status(422).json({ error: "Planner returned no systems", plan });

      let scripts = await Promise.all(systems.map(async (s) => {
        const code = stripCode(await ask(CODER + ctx, `Plan:\n${JSON.stringify(plan)}\n\nYour assignment: ${JSON.stringify(s)}`, "medium"));
        const rev = parseReview(await ask(REVIEW, `Plan:\n${JSON.stringify(plan)}\n\nScript (${s.name}):\n${code}`, "high"), code);
        return { ...s, code: rev.code, issues: rev.issues };
      }));

      let report = await ask(INTEGRATE, bundle(scripts), "high");
      let autofixed = false;
      if (autofix && !/^\s*OK\b/i.test(report)) {
        const current = bundle(scripts);
        scripts = await Promise.all(scripts.map(async (s) => ({
          ...s,
          code: stripCode(await ask(FIX, `Integration problems:\n${report}\n\nAll scripts:\n${current}\n\nFix ONLY this script: ${s.name}`, "high")),
        })));
        report = await ask(INTEGRATE, bundle(scripts), "high");
        autofixed = true;
      }

      for (const s of scripts) {
        const m = s.issues.split("\n").find((l) => /high/i.test(l));
        if (m) await addLesson(m.replace(/^[-\s]+/, ""));
      }

      const r = await db.query(
        "INSERT INTO builds(project, request, plan, scripts, report, parent_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [project, request, JSON.stringify(plan), JSON.stringify(scripts), report, parent]);
      res.json({ buildId: r.rows[0].id, autofixed, plan, scripts, report });
    } catch (e) { console.error(e); res.status(500).json({ error: "Build failed" }); }
  });

  app.get("/builds", auth, wrap(async (req, res) => {
    const r = await db.query("SELECT id, request, parent_id, created_at FROM builds WHERE project=$1 ORDER BY id DESC LIMIT 30", [req.query.project || "main"]);
    res.json(r.rows);
  }));
  app.get("/builds/:id", auth, wrap(async (req, res) => {
    const r = await db.query("SELECT * FROM builds WHERE id=$1", [parseInt(req.params.id) || 0]);
    r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: "Not found" });
  }));

  app.post("/improve", auth, async (req, res) => {
    try {
      const code = String(req.body.code || "").slice(0, 15000);
      const goal = String(req.body.goal || "improve quality and performance").slice(0, 500);
      const rev = parseReview(await ask(IMPROVE, `Goal: ${goal}\n\nCode:\n${code}`, "high"), code);
      const regression = await ask(
        "You are a regression checker. Compare ORIGINAL and NEW Luau. List any behavior that was removed or changed. Reply SAME if nothing changed.",
        `ORIGINAL:\n${code}\n\nNEW:\n${rev.code}`, "high");
      res.json({ issues: rev.issues, code: rev.code, regression });
    } catch (e) { console.error(e); res.status(500).json({ error: "Error" }); }
  });

  const SECRETS = [
    /gsk_[A-Za-z0-9]{20,}/, /sk-[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{30,}/,
    /Bearer\s+[A-Za-z0-9._-]{20,}/, /(api[_-]?key|token|secret)\s*[=:]\s*["'][^"']{12,}["']/i,
  ];
  app.post("/scan", auth, async (req, res) => {
    try {
      const code = String(req.body.code || "").slice(0, 15000);
      const findings = await ask(
        "You are a Roblox security auditor. List unsafe patterns: RemoteEvents that trust client values (damage, currency, position), missing rate limits, exposed secrets or URLs, loadstring or require of unknown assets, DataStore misuse. Give severity and a one-line fix for each. Reply CLEAN if nothing.",
        code, "high");
      res.json({ possibleSecrets: SECRETS.some((r) => r.test(code)), findings });
    } catch (e) { console.error(e); res.status(500).json({ error: "Error" }); }
  });

  app.post("/ideas", auth, async (req, res) => {
    try {
      const theme = String(req.body.theme || "any").slice(0, 300);
      const ctx = await context(req.body.project || "main", theme);
      const out = await ask(
        "You are a creative Roblox game designer. Give 5 original, buildable mechanics for the theme. For each: name, one-sentence hook, what the player does, and scripting difficulty (easy/medium/hard). Avoid cliches." + ctx,
        theme, "medium");
      res.json({ ideas: out });
    } catch (e) { console.error(e); res.status(500).json({ error: "Error" }); }
  });
};
