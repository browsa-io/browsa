// capbench: runs a fixed set of public captcha test pages against any CDP browser and prints, per captcha type,
// attempts, passes and the median seconds of a pass.
//
//   Any vendor:  CDP_URL=wss://... node capbench.js            one browser for all targets, ROUNDS times
//   Browsa:      BROWSA_API_KEY=... [PROXY=socks5://user:pass@host:port] node capbench.js
//                a fresh browser for every attempt (set SHARED=1 for one browser per round)
//
// Env: ROUNDS (5), ONLY=id,id, SKIP=id,id, OUT=dir (results JSON and failure screenshots), LABEL=name
//
// The script does what a person does without solving a puzzle: one click on a checkbox or "verify" button,
// then submit. It solves nothing itself, so a vendor's built-in solver, if it has one, is free to act and the
// result shows what that browser gets through.
//
// Result of an attempt
//   pass        the site's server accepted it (success page, score, or the protected page loaded)
//   token       a token was issued, but the test page has no server-side check to confirm it (marked *)
//   challenge   a puzzle was shown (image grid, slider, text) and nothing solved it
//   blocked     the test page itself refused the browser
//   fail/error  submitted and rejected, or the run broke
// Only "pass" counts as a pass. The script uses raw mouse input and never calls locator.click()/fill(),
// which announce themselves to the page in Playwright.
const { chromium } = require("playwright-core"); const fs = require("fs");
const env = process.env, ROUNDS = +(env.ROUNDS || 5), LABEL = env.LABEL || "run";
const OUT = env.OUT || "."; const key = env.BROWSA_API_KEY;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN_JS = `(() => { const q = s => { const e = document.querySelector(s); const v = e && (e.value || ""); return v && v[0] !== "." ? v : ""; };
  return q('[name="g-recaptcha-response"]') || q('[name="h-captcha-response"]') || q('[name="cf-turnstile-response"]') || q('[name="frc-captcha-response"]') || q('[name="frc-captcha-solution"]') || q('[name="altcha"]') || ""; })()`;
const text = p => p.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
const token = p => p.evaluate(TOKEN_JS).catch(() => "");
async function frameBox(p, re) { for (const f of p.frames()) { if (!re.test(f.url())) continue; try { const el = await f.frameElement(); const b = await el.boundingBox(); if (b && b.width > 20 && b.height > 20) return b; } catch { } } return null; }
async function mouseClick(p, x, y) { const sx = 200 + Math.random() * 300, sy = 150 + Math.random() * 200; await p.mouse.move(sx, sy); await p.mouse.move(x + (Math.random() * 6 - 3), y + (Math.random() * 6 - 3), { steps: 14 + Math.floor(Math.random() * 10) }); await sleep(120 + Math.random() * 200); await p.mouse.down(); await sleep(60 + Math.random() * 70); await p.mouse.up(); }
async function clickFrame(p, re, dx = 30, dyFrac = 0.5) { const b = await frameBox(p, re); if (!b) return false; await mouseClick(p, b.x + dx, b.y + b.height * dyFrac); return true; }
async function clickSel(p, sel) { const l = p.locator(sel).first(); try { await l.scrollIntoViewIfNeeded({ timeout: 4000 }); const b = await l.boundingBox(); if (!b) return false; await mouseClick(p, b.x + b.width / 2, b.y + b.height / 2); return true; } catch { return false; } }
const clickText = (p, re) => clickSel(p, `button:visible:text-matches("${re}", "i")`).then(ok => ok || clickSel(p, `input[type=submit]:visible, a:visible:text-matches("${re}", "i")`));
async function waitFor(fn, ms, step = 700) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step); } }
// A puzzle frame is "shown" when its iframe is on screen and large.
async function puzzleShown(p, re) { const b = await frameBox(p, re); return !!(b && b.height > 250 && b.width > 250 && b.y > -50 && b.y < 2000); }

// ---- targets -------------------------------------------------------------------------------------------------
// run(p, ctx) returns { result, note?, score? }.
const T = [];
const add = (id, type, url, verified, run, opt = {}) => T.push({ id, type, url, verified, run, ...opt });

async function widgetFlow(p, o) { // generic: optional click on widget, wait token or puzzle, submit, verify
  if (o.pre) await o.pre(p);
  if (o.widget) { await waitFor(() => frameBox(p, o.widget), 15000); await sleep(1500 + Math.random() * 1500); }
  let tk = await token(p);
  if (!tk && o.widget && o.click !== false) { await clickFrame(p, o.widget, o.dx || 30, o.dy || 0.5); }
  tk = tk || await waitFor(async () => (await token(p)) || (o.puzzle && await puzzleShown(p, o.puzzle) ? "PUZZLE" : ""), o.wait || 20000);
  if (tk === "PUZZLE") return { result: "challenge" };
  if (!tk && !o.submitAnyway) return { result: o.puzzle ? "challenge" : "fail", note: "no token" };
  if (!o.submit) return { result: "token" };
  await sleep(600); const ok = await o.submit(p); if (!ok) return { result: "error", note: "submit control not found" };
  const body = await waitFor(async () => { const t = await text(p); return o.ok.test(t) || (o.bad && o.bad.test(t)) ? t : ""; }, o.verifyWait || 15000);
  if (!body) { if (o.puzzle && await puzzleShown(p, o.puzzle)) return { result: "challenge" }; return { result: "fail", note: "no verdict after submit" }; }
  return o.ok.test(body) ? { result: "pass" } : { result: "fail", note: "rejected by the site" };
}
const RC_ANCHOR = /recaptcha\/(api2|enterprise)\/anchor/, RC_BFRAME = /recaptcha\/(api2|enterprise)\/bframe/;
add("recaptcha_v2_checkbox", "reCAPTCHA v2 checkbox", "https://www.google.com/recaptcha/api2/demo", true,
  p => widgetFlow(p, { widget: RC_ANCHOR, dx: 28, puzzle: RC_BFRAME, submit: p => clickSel(p, "#recaptcha-demo-submit"), ok: /Verification Success/i }));
add("recaptcha_v2_invisible", "reCAPTCHA v2 invisible", "https://www.google.com/recaptcha/api2/demo?invisible=true", true,
  async p => { await sleep(2500); if (!await clickSel(p, "#recaptcha-demo-submit")) return { result: "error", note: "no submit" };
    const v = await waitFor(async () => /Verification Success/i.test(await text(p)) ? "ok" : (await puzzleShown(p, RC_BFRAME) ? "puzzle" : ""), 20000);
    return v === "ok" ? { result: "pass" } : v === "puzzle" ? { result: "challenge" } : { result: "fail", note: "no verdict" }; });
add("recaptcha_v3_score", "reCAPTCHA v3 score", "https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php", true,
  async p => { const t = await waitFor(async () => { const t = await text(p); return /"score":/.test(t) ? t : ""; }, 20000); if (!t) return { result: "fail", note: "no score returned" };
    const s = +(t.match(/"score":\s*([0-9.]+)/) || [])[1]; return { result: s >= 0.7 ? "pass" : "fail", score: s, note: "score " + s }; });
add("recaptcha_enterprise_v2", "reCAPTCHA Enterprise v2", "https://2captcha.com/demo/recaptcha-v2-enterprise", true,
  p => widgetFlow(p, { widget: RC_ANCHOR, dx: 28, puzzle: RC_BFRAME, submit: p => clickText(p, "^\\\\s*Check\\\\s*$"), ok: /passed successfully/i, bad: /not passed|failed|incorrect|error/i }));
const HC = /hcaptcha\.com\/captcha\/v1\/[^/]+\/static\/hcaptcha\.html.*frame=checkbox|hcaptcha\.com\/captcha.*#frame=checkbox/, HCP = /hcaptcha\.com\/captcha.*frame=challenge/;
add("hcaptcha_official", "hCaptcha (vendor demo)", "https://accounts.hcaptcha.com/demo", true,
  async p => { if (/blocked|Attention Required/i.test(await p.title().catch(() => ""))) return { result: "blocked", note: "demo page refused the address" };
    return widgetFlow(p, { widget: /hcaptcha\.com\/captcha/, dx: 30, puzzle: HCP, submit: p => clickSel(p, 'input[type=submit], button[type=submit]'), ok: /"success":\s*true|Verification Success|passed/i, bad: /"success":\s*false/i }); });
add("hcaptcha_enterprise", "hCaptcha Enterprise (demo widget)", "https://nopecha.com/demo/hcaptcha", false,
  p => widgetFlow(p, { widget: /hcaptcha\.com\/captcha/, dx: 30, puzzle: HCP, wait: 15000 }));
const CF = /challenges\.cloudflare\.com/;
add("turnstile_form", "Turnstile (third-party form)", "https://2captcha.com/demo/cloudflare-turnstile", true,
  p => widgetFlow(p, { widget: CF, dx: 30, wait: 20000, submit: p => clickText(p, "^\\\\s*Check\\\\s*$"), ok: /passed successfully/i, bad: /not passed|failed|incorrect/i }));
add("turnstile_noninteractive", "Turnstile non-interactive", "https://peet.ws/turnstile-test/non-interactive.html", false,
  p => widgetFlow(p, { widget: CF, click: false, wait: 20000 }));
add("turnstile_invisible", "Turnstile invisible", "https://peet.ws/turnstile-test/invisible.html", false,
  async p => { const tk = await waitFor(async () => (await token(p)) || (/token|success/i.test(await text(p)) && (await text(p)).length > 40 ? "text" : ""), 20000); return tk ? { result: "token" } : { result: "fail", note: "no token" }; });
add("cloudflare_challenge", "Cloudflare full-page challenge", "https://nopecha.com/demo/cloudflare", true,
  async (p, ctx) => { // no DOM reads while the challenge is up: title comes from the browser target list
    const title = async () => { try { const s = await ctx.browser.newBrowserCDPSession(); const r = await s.send("Target.getTargets"); await s.detach().catch(() => { }); const t = r.targetInfos.find(t => t.type === "page" && /nopecha\.com/.test(t.url)); return t ? t.title : ""; } catch { return "?"; } };
    const passed = async () => { const t = await title(); return t && t !== "?" && !/just a moment|attention required/i.test(t) ? t : ""; };
    let ok = await waitFor(passed, 9000, 1500); let clicks = 0;
    while (!ok && clicks < 2) { if (await clickFrame(p, CF, 30)) clicks++; else await sleep(3000); ok = await waitFor(passed, 12000, 1500); if (!clicks && !ok) break; }
    return ok ? { result: "pass", note: clicks ? clicks + " click" : "no click" } : { result: "fail", note: clicks ? "click not accepted" : "no checkbox offered" }; });
add("datadome_site", "DataDome (protected site)", "https://www.g2.com/", true,
  async p => { await sleep(14000); const frames = p.frames().map(f => f.url()).join(" "); const t = await p.title().catch(() => "");
    if (/captcha-delivery\.com/.test(frames)) return { result: "challenge", note: "captcha or block page" }; return /G2/i.test(t) && !/denied|blocked/i.test(t) ? { result: "pass" } : { result: "fail", note: "title " + t.slice(0, 40) }; }, { defaultExitOnly: true });
add("aws_waf", "AWS WAF captcha", "https://nopecha.com/demo/awscaptcha", false,
  async p => { await sleep(6000); const b = await frameBox(p, /amazon|awswaf/); const t = await text(p); if (!b) return { result: "error", note: "widget frame not found" };
    const inner = p.frames().find(f => /amazon|awswaf/.test(f.url())); const ft = inner ? await inner.evaluate(() => document.body ? document.body.innerText : "").catch(() => "") : "";
    if (/403 ERROR|Request blocked/i.test(ft)) return { result: "blocked", note: "demo content refused the address (403)" };
    return /solve|puzzle|choose|begin|confirm|captcha/i.test(ft + t) ? { result: "challenge", note: "puzzle shown" } : { result: "fail", note: "unknown state" }; });
add("friendly_captcha", "Friendly Captcha (proof of work)", "https://friendlycaptcha.com/demo/", false,
  async p => { await sleep(3000); if (await clickSel(p, 'input[placeholder*="full name" i]')) { await p.keyboard.type("Alex Morgan", { delay: 90 }); }
    await sleep(2000); const w = p.frames().find(f => /frcapi\.com\/api\/v2\/captcha\/widget/.test(f.url())); if (w) { try { const el = await w.frameElement(); await el.scrollIntoViewIfNeeded(); const b = await el.boundingBox(); if (b) await mouseClick(p, b.x + 30, b.y + b.height / 2); } catch { } }
    const tk = await waitFor(() => token(p), 30000); return tk ? { result: "token" } : { result: "fail", note: "no solution" }; });
add("image_text", "Image text captcha", "https://2captcha.com/demo/normal", true,
  async p => { await sleep(3000); const has = await p.evaluate(() => !!document.querySelector('img[src*="captcha"], img[alt*="captcha" i]')).catch(() => false); return has ? { result: "challenge", note: "distorted text needs reading" } : { result: "error", note: "image not found" }; });

// ---- runner --------------------------------------------------------------------------------------------------
const H = key ? { Authorization: "Bearer " + key, "Content-Type": "application/json" } : {};
const api = async (m, path, b) => { const r = await fetch("https://browsa.io" + path, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); let j = {}; try { j = JSON.parse(await r.text()); } catch { } return { status: r.status, j: j.data || j }; };
function proxyBody() { if (!env.PROXY) return {}; const u = new URL(env.PROXY); return { proxy: { type: u.protocol.replace(":", ""), host: u.hostname, port: +u.port, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), country: "US" } }; }
async function open() { if (env.CDP_URL) { const br = await chromium.connectOverCDP(env.CDP_URL); return { br, close: () => br.close().catch(() => { }) }; }
  let a; for (let i = 0; i < 12; i++) { a = await api("POST", "/v1/agents", { ttl_seconds: 1500, ...proxyBody() }); if (a.j.id || a.status !== 429) break; await sleep(30000); } if (!a.j.id) throw new Error("create failed " + a.status);
  try { const br = await chromium.connectOverCDP(a.j.cdp_http + "?apiKey=" + key, { headers: { Authorization: "Bearer " + key } }); return { br, close: async () => { await br.close().catch(() => { }); await api("DELETE", "/v1/agents/" + a.j.id); } }; }
  catch (e) { await api("DELETE", "/v1/agents/" + a.j.id); throw e; } }
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
async function attempt(s, t, r) { // one target in an open browser; returns the result row
  const t0 = Date.now(); let out;
  try {
    const ctx = s.br.contexts()[0] || await s.br.newContext(); const p = ctx.pages().find(x => !x.isClosed()) || await ctx.newPage();
    const st = await p.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 }).then(r => r ? r.status() : 0).catch(e => "ERR " + e.message.slice(0, 50));
    if (typeof st === "string") out = { result: "error", note: st };
    else out = await Promise.race([t.run(p, { browser: s.br }), sleep(75000).then(() => ({ result: "error", note: "timeout" }))]);
    if (out.result !== "pass" && out.result !== "token") await p.screenshot({ path: `${OUT}/shots/${LABEL}-${t.id}-${r}.png` }).catch(() => { });
    await p.goto("about:blank").catch(() => { });
  } catch (e) { out = { result: "error", note: e.message.slice(0, 90) }; }
  return { label: LABEL, at: new Date(t0).toISOString(), round: r, id: t.id, type: t.type, verified: t.verified, seconds: +((Date.now() - t0) / 1000).toFixed(1), ...out };
}
(async () => {
  const only = (env.ONLY || "").split(",").filter(Boolean), skip = (env.SKIP || "").split(",").filter(Boolean);
  const targets = T.filter(t => (!only.length || only.includes(t.id)) && !skip.includes(t.id) && !(t.defaultExitOnly && env.PROXY));
  const fresh = !env.CDP_URL && !env.SHARED; // a new browser for every attempt needs an API that can create one
  const rows = []; fs.mkdirSync(OUT + "/shots", { recursive: true });
  const log = row => { rows.push(row); console.log(JSON.stringify(row)); };
  for (let r = 1; r <= ROUNDS; r++) {
    if (fresh) {
      for (const t of targets) {
        let s; try { s = await open(); } catch (e) { log({ label: LABEL, round: r, id: t.id, type: t.type, verified: t.verified, result: "error", note: "no browser: " + e.message.slice(0, 80) }); continue; }
        try { log(await attempt(s, t, r)); } finally { await s.close(); }
      }
    } else {
      let s; try { s = await open(); } catch (e) { console.log(JSON.stringify({ round: r, error: e.message.slice(0, 120) })); continue; }
      try { for (const t of targets) { log(await attempt(s, t, r)); await sleep(1500); } } finally { await s.close(); }
    }
  }
  fs.writeFileSync(`${OUT}/${LABEL}.json`, JSON.stringify(rows, null, 1));
  console.log("\n" + ["type", "attempts", "pass", "token", "challenge", "blocked", "fail", "error", "median s (pass)"].join(" | "));
  for (const t of targets) {
    const rs = rows.filter(x => x.id === t.id); const c = k => rs.filter(x => x.result === k).length;
    console.log([t.type + (t.verified ? "" : " *"), rs.length, c("pass"), c("token"), c("challenge"), c("blocked"), c("fail"), c("error"), med(rs.filter(x => x.result === "pass").map(x => x.seconds)) ?? "-"].join(" | "));
  }
  console.log("* no server-side check on that test page: a token was issued, acceptance not confirmed");
  console.log(fresh ? "fresh browser per attempt" : "one browser per round: later targets in a round see the earlier ones' cookies");
})().catch(e => { console.log("ERR", e.message.slice(0, 200)); process.exit(1); });
