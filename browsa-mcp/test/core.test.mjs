// The nine core tools against a mocked Browsa API (no network, no real key).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockApi, startMcp } from "./helpers.mjs";

const CORE = ["open", "observe", "act", "read", "screenshot", "secrets", "handoff", "flow", "close"];

const VIEW = [
  'page "Books" https://books.example/catalogue/?session=s3cr3t-sess&page=2  scroll 0 of 900, viewport 1280x720',
  "[2] form",
  '  [3] searchbox "Search"  empty',
  '  [4] button "Go"',
  '[5] table "Prices"  (3 rows × 2 cols)',
  '  cols "Title" | "Price"',
  '  row "A Light" | "£51.77"',
  '[8] list',
  '  [9] link "A Light in the Attic"  → /a-light',
  '  [10] link "Tipping the Velvet"  → /tipping?token=abc123',
  'text "In stock"',
  "dialog: none  frames: none",
].join("\n");

const VIEW_JSON = {
  elements: [
    { id: 2, kind: "element", role: "form" },
    { id: 3, kind: "element", role: "searchbox", name: "Search", parent: 2 },
    { id: 5, kind: "element", role: "table", name: "Prices" },
    { kind: "row", role: "row", cells: ["Title", "Price"], header: true, parent: 5 },
    { kind: "row", role: "row", cells: ["A Light", "£51.77"], parent: 5 },
    { kind: "row", role: "row", cells: ["Tipping\tthe Velvet", "£53.74"], parent: 5 },
    { id: 8, kind: "element", role: "list" },
    { id: 9, kind: "element", role: "link", name: "A Light in the Attic", parent: 8, state: { href: "https://books.example/a-light" } },
    { id: 10, kind: "element", role: "link", name: "Tipping the Velvet", parent: 8, state: { href: "https://books.example/tipping?token=abc123" } },
  ],
};

const BIG_DIFF = "after: click [4]\n" + Array.from({ length: 120 }, (_, i) => `+ text "row ${i} with some words to make it long"`).join("\n");

function routes() {
  return {
    "POST /v1/agents": (b, u, st) => {
      st.created = b;
      return { id: "agt_1", status: "running", expires_at: "2026-11-19T12:10:00Z", cost_credits: 1,
        live_url: "https://browsa.io/live?agent=agt_1#c=lc_payload.mac" };
    },
    "POST /v1/agents/agt_1/observe": (b, u, st) => {
      st.observes = (st.observes ?? 0) + 1;
      if (b?.screenshot) {
        if (st.oldServer) return { text: VIEW, state: "ok", url: "https://books.example/", tab: "T1", session: "pv_a" };
        if (b.screenshot.id === 99) return [400, { code: "ELEMENT_NOT_VISIBLE", error: "that element is gone or not visible" }];
        return { screenshot: { mime: "image/jpeg", data: "/9j/4AAQ", width: 1280, height: 720, scale: 1 }, url: "https://books.example/", tab: "T1", session: "pv_a", ids_reset: false };
      }
      if (st.flipAt && st.observes >= st.flipAt) { st.url = "https://books.example/account"; st.flipAt = 0; }
      const url = st.url ?? "https://books.example/";
      const out = { text: st.viewText ?? VIEW, state: st.challenge ? "challenge" : "ok", url, title: "Books", tab: "T1", tabs: [{ id: "T1", active: true }], session: "pv_a", ids_reset: false };
      if (st.challenge) out.challenge = { kind: st.challenge };
      if (b?.json) out.view = VIEW_JSON;
      if (b?.selector && b?.expand) out.selector = b.expand === 5 ? "#prices" : "#list";
      return out;
    },
    "POST /v1/agents/agt_1/act": (b, u, st) => {
      st.acts = [...(st.acts ?? []), b];
      const base = { tab: "T1", session: "pv_a", ids_reset: false, url: st.url ?? "https://books.example/", settle: {} };
      const forced = st.next?.shift?.();
      if (forced) return { ...base, ...forced };
      if (b.action === "navigate") {
        st.url = b.url;
        return { ...base, url: b.url, status: "ok", fresh_view: "new page", navigation: { url: b.url, same_document: false },
          text: `after: navigate ${b.url}\nnavigated → ${b.url}  (new page, 9 elements)\n${VIEW}` };
      }
      if (b.action === "solve_captcha") return { ...base, status: "ok", text: "solved: turnstile, 1 round(s), 9 s\n" + VIEW };
      if (b.secret) {
        return { ...base, status: "ok", secret: b.secret, text: `after: type [${b.id}] secret ${b.secret} (hidden)\n~ [${b.id}] textbox "Email"  value "<secret>${b.secret}</secret>"`,
          target: b.record ? { role: "textbox", name: "Email", css: "#email" } : undefined };
      }
      return { ...base, status: "ok", text: `after: ${b.action} [${b.id}]\n~ [3] searchbox "Search"  value "x"\nsettled after 0 ms, no requests`,
        target: b.record && b.id ? { role: b.id === 3 ? "searchbox" : "button", name: b.id === 3 ? "Search" : "Go", css: `#e${b.id}` } : undefined };
    },
    "POST /v1/agents/agt_1/live": (b) => ({ live_url: "https://browsa.io/live?agent=agt_1#c=lc_ctl.mac", expires_at: "2026-11-19T12:30:00Z", scope: b.scope, agent_id: "agt_1" }),
    "DELETE /v1/agents/agt_1": () => ({ ok: true }),
    "POST /v1/agents/agt_gone/observe": () => [409, { code: "AGENT_NOT_RUNNING", error: "agent is destroyed" }],
    "GET /v1/secrets": (b, u, st) => st.noSecrets ? [404, { code: "NOT_FOUND", error: "404 page not found" }] : ({
      secrets: [
        { id: "s1", name: "GITHUB", type: "login", origins: ["https://*.github.com"], description: "release bot", has_totp: true,
          placeholders: ["GITHUB:username", "GITHUB:password", "TOTP:GITHUB"], username_masked: "re…" },
        { id: "s2", name: "STRIPE_KEY", type: "value", origins: ["*"], placeholders: ["STRIPE_KEY"], has_totp: false },
        { id: "s3", name: "OLD_PIN", type: "value", origins: [], placeholders: ["OLD_PIN"], has_totp: false },
      ], limit: 500,
    }),
    "GET /v1/recipes": (b, u, st) => ({ recipes: st.recipes ?? [] }),
    "POST /v1/recipes": (b, u, st) => {
      st.savedRecipe = b;
      const r = { id: "rec_1", name: b.name, status: "active", current_version: 1, price_credits: 9 };
      st.recipes = [...(st.recipes ?? []), r];
      return [201, r];
    },
    "POST /v1/recipes/rec_1/run": (b, u, st) => {
      st.runBody = b;
      if (st.runFails) return [202, { id: "run_1", status: "running", version: 1 }];
      return [200, { id: "run_1", status: "ok", version: b.version ?? 1, duration_ms: 4100, credits: 9, output: { read_1: [{ title: "A Light" }] } }];
    },
    "GET /v1/recipe-runs/run_1": () => ({ id: "run_1", status: "failed", version: 1, error_code: "site_changed", error_message: "step s2 failed: no element",
      layers: [{ step: "s1", ok: true }, { step: "s2", ok: false, error: "no button Go" }] }),
  };
}

describe("core tools: catalog", () => {
  test("nine tools by default, schemas within 1.8k tokens (chars / 4)", async () => {
    const mcp = await startMcp(undefined).init();
    try {
      const tools = await mcp.tools();
      assert.deepEqual(tools.map((t) => t.name), CORE);
      let total = 0;
      const sizes = {};
      for (const t of tools) {
        const n = JSON.stringify(t).length;
        sizes[t.name] = Math.ceil(n / 4);
        total += n;
        assert.equal(t.inputSchema.type, "object");
        assert.ok(!/—/.test(JSON.stringify(t)), `em dash in ${t.name}`);
      }
      const tokens = Math.ceil(total / 4);
      console.log("schema tokens:", JSON.stringify(sizes), "total", tokens);
      assert.ok(tokens <= 1800, `core schemas are ${tokens} tokens`);
    } finally { mcp.kill(); }
  });

  test("groups by env or --tools; all = every 0.5 tool plus core; a group tool that is off says how to turn it on", async () => {
    let mcp = await startMcp(undefined, { BROWSA_MCP_TOOLS: "robots,tasks" }).init();
    let names = (await mcp.tools()).map((t) => t.name);
    assert.deepEqual(names.slice(0, 9), CORE);
    assert.deepEqual(names.slice(9).sort(), ["cancel_job", "get_job", "get_robot_run", "list_job_files", "list_robots", "respond_to_job", "run_robot", "run_task"]);
    const off = await mcp.call("credits");
    assert.equal(off.isError, true);
    assert.match(off.text, /optional group "admin"/);
    assert.match(off.text, /BROWSA_MCP_TOOLS=admin/);
    mcp.kill();

    mcp = await startMcp(undefined, {}, { args: ["--tools=admin"] }).init();
    names = (await mcp.tools()).map((t) => t.name);
    assert.ok(names.includes("credits") && names.includes("list_models") && !names.includes("run_task"));
    mcp.kill();

    mcp = await startMcp(undefined, { BROWSA_MCP_TOOLS: "all" }).init();
    const all = await mcp.tools();
    names = all.map((t) => t.name);
    for (const n of ["run_task", "get_job", "cancel_job", "respond_to_job", "start_browser", "stop_browser", "proxy_network", "list_browsers",
      "credits", "list_webhooks", "create_webhook", "delete_webhook", "list_identities", "create_schedule", "list_schedules", "list_llm_keys",
      "list_models", "list_job_files", "list_robots", "run_robot", "get_robot_run", "solve_captcha_task", ...CORE]) {
      assert.ok(names.includes(n), `all lacks ${n}`);
    }
    assert.equal(new Set(names).size, names.length, "a tool is listed twice");
    // no other MCP server or company is named in any tool text
    const text = JSON.stringify(all);
    assert.ok(!/playwright|puppeteer|capsolver|anti-captcha|capmonster|2captcha|akamai|cloudflare|datadome|openai|google|chromium|microsoft|browserbase/i.test(text),
      "a tool text names another company or product");
    mcp.kill();

    mcp = await startMcp(undefined, { BROWSA_MCP_TOOLS: "robots,nonsense" }).init();
    await mcp.tools();
    assert.match(mcp.stderr(), /unknown group or tool "nonsense"/);
    mcp.kill();
  });
});

describe("core tools against a mocked API", () => {
  let api, mcp, cwd;
  before(async () => {
    api = await startMockApi(routes());
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "browsa-mcp-cwd-"));
    mcp = await startMcp(api.url, { BROWSA_HANDOFF_POLL_MS: "20" }, { cwd }).init();
  });
  after(() => { mcp?.kill(); api?.close(); fs.rmSync(cwd, { recursive: true, force: true }); });

  test("act before open says to call open", async () => {
    const r = await mcp.call("act", { action: "click", id: 4 });
    assert.equal(r.isError, true);
    assert.match(r.text, /^error: no browser yet\nnext: call open first$/);
  });

  test("open creates a cloud browser, navigates, and returns the id, the live link and the first view", async () => {
    const r = await mcp.call("open", { url: "https://books.example/", country: "us", proxy: { network: "residential", country: "us" } });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(api.state.created, { ttl: "10m", country: "us", proxy: { network: "residential", country: "us" } });
    const lines = r.text.split("\n");
    assert.match(lines[0], /^ok: browser agt_1 is open \(Phantom, cloud, Browsa residential proxy\)/);
    assert.equal(lines[1], "live view (single use, for a person): https://browsa.io/live?agent=agt_1#c=lc_payload.mac");
    assert.equal(lines[2], "ok");
    assert.ok(r.text.includes('[3] searchbox "Search"'));
    assert.deepEqual(api.last("/v1/agents/agt_1/act").body, { action: "navigate", url: "https://books.example/" });
    const bad = await mcp.call("open", { where: "local" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /only cloud browsers/);
  });

  test("tokens in URLs are masked in every answer; the live link is kept", async () => {
    const r = await mcp.call("observe", {});
    assert.ok(r.text.includes("?session=***&page=2"), r.text);
    assert.ok(r.text.includes("/tipping?token=***"), r.text);
    assert.ok(!r.text.includes("s3cr3t-sess") && !r.text.includes("abc123"));
  });

  test("observe: default budget 1500, capped at 6000, the session goes back", async () => {
    await mcp.call("observe", { budget: 99999, scope: "page" });
    assert.deepEqual(api.last("/v1/agents/agt_1/observe").body, { scope: "page", budget: 6000, session: "pv_a" });
    await mcp.call("observe", {});
    assert.deepEqual(api.last("/v1/agents/agt_1/observe").body, { budget: 1500, session: "pv_a" });
  });

  test("observe find returns only the matching lines, with their container", async () => {
    const r = await mcp.call("observe", { find: "velvet" });
    assert.deepEqual(api.last("/v1/agents/agt_1/observe").body, { scope: "page", budget: -1, session: "pv_a" });
    assert.match(r.text, /^find "velvet": 1 match\npage "Books"/);
    assert.ok(r.text.includes('[10] link "Tipping the Velvet"  → /tipping?token=***   (in [8] list)'), r.text);
    assert.ok(!r.text.includes("Search"), "non-matching lines leaked into find");
    const rx = await mcp.call("observe", { find: "/£5\\d/" });
    assert.match(rx.text, /^find "\/£5\\\\d\/": 1 match/);
  });

  test("act sends the action with the session; the first line is the status", async () => {
    const r = await mcp.call("act", { action: "type", id: 3, text: "poetry", submit: true });
    assert.deepEqual(api.last("/v1/agents/agt_1/act").body, { action: "type", id: 3, text: "poetry", submit: true, session: "pv_a" });
    assert.match(r.text, /^ok\nafter: type \[3\]/);

    const cases = [
      [{ status: "failed", reason: "unknown id 77", text: "after: click [77]\nfailed: unknown id 77" }, /^failed: unknown id 77; next: use an id from this view, or observe\nafter: click \[77\]$/],
      [{ status: "blocked", reason: 'element [4] is covered by [31] dialog "Cookies"', text: "after: click [4]\nblocked: x" }, /^blocked: element \[4\] is covered by \[31\] dialog "Cookies"; next: close what covers it/],
      [{ status: "challenge", reason: "cloudflare full-page check is up", challenge: { kind: "cloudflare" }, text: "after: click [4]\nchallenge: x" }, /^challenge: cloudflare full-page check is up; next: act solve_captcha, and if it stays, handoff/],
      [{ status: "stale", reason: "ids reset", ids_reset: true, text: "stale: element ids were reset\n" + VIEW }, /^stale: the page changed and those ids are gone; nothing was done\. Fresh view:\npage "Books"/],
      [{ status: "ok", dialog: { type: "confirm", message: "Leave?" }, text: "after: click [4]\ndialog [x]" }, /^dialog: a dialog is open \(confirm: "Leave\?"\); next: act with action dialog and accept true or false/],
      [{ status: "blocked", reason: "a JavaScript dialog is open", dialog: { type: "alert", message: "Hi" }, text: "after: click [4]\nblocked: a dialog" }, /^dialog: a dialog is open/],
      [{ status: "secret_origin", reason: "secret GITHUB:password may not be typed on https://evil.test; nothing was typed", text: "after: type [3] secret GITHUB:password (hidden)\nsecret_origin: x" },
        /^secret_origin: secret GITHUB:password may not be typed on https:\/\/evil\.test; nothing was typed; next: check the page, secrets lists where each secret may be typed\nafter: type/],
    ];
    for (const [answer, want] of cases) {
      api.state.next = [answer];
      const a = await mcp.call("act", { action: "click", id: 4 });
      assert.match(a.text, want);
      assert.equal(a.isError, false);
    }
  });

  test("a diff over 400 tokens is replaced with a fresh view inside the budget", async () => {
    api.state.next = [{ status: "ok", text: BIG_DIFF }];
    const before = api.calls.length;
    const r = await mcp.call("act", { action: "click", id: 4 });
    assert.match(r.text, /^ok\nafter: click \[4\]\nlarge change, fresh view:\npage "Books"/);
    const obs = api.calls.slice(before).find((c) => c.path.endsWith("/observe"));
    assert.equal(obs.body.budget, 1500);
    assert.ok(r.text.length < 1600 * 1.5);
  });

  test("act with a secret sends only the reference; solve_captcha reports the solver", async () => {
    const r = await mcp.call("act", { action: "type", id: 3, secret: "GITHUB:password" });
    assert.deepEqual(api.last("/v1/agents/agt_1/act").body, { action: "type", id: 3, secret: "GITHUB:password", session: "pv_a" });
    assert.match(r.text, /^ok\nafter: type \[3\] secret GITHUB:password \(hidden\)/);
    // an API without secret typing ignores the field: never report it as typed
    api.state.next = [{ status: "ok", text: "after: type [3] \"\"\nno change" }];
    const old = await mcp.call("act", { action: "type", id: 3, secret: "GITHUB:password" });
    assert.match(old.text, /^failed: this Browsa server cannot type secrets yet, so nothing was typed/);
    const c = await mcp.call("act", { action: "solve_captcha" });
    assert.match(c.text, /^ok: captcha solved: turnstile, 1 round\(s\), 9 s\npage "Books"/);
    api.state.next = [{ status: "failed", reason: "timeout", text: "not solved: the puzzle did not clear\n" + VIEW }];
    const f = await mcp.call("act", { action: "solve_captcha" });
    assert.match(f.text, /^failed: captcha not solved: the puzzle did not clear; next: call handoff/);
  });

  test("read: a table as TSV, links, and a container's text, with no model", async () => {
    const t = await mcp.call("read", { id: 5, as: "table" });
    assert.deepEqual(api.last("/v1/agents/agt_1/observe").body, { expand: 5, scope: "page", budget: -1, json: true, selector: true, session: "pv_a" });
    assert.equal(t.text, "ok: [5] as table\nTitle\tPrice\nA Light\t£51.77\nTipping the Velvet\t£53.74");
    const l = await mcp.call("read", { id: 8, as: "links" });
    assert.equal(l.text, "ok: [8] as links\nA Light in the Attic\thttps://books.example/a-light\nTipping the Velvet\thttps://books.example/tipping?token=***");
    const x = await mcp.call("read", { id: 2 });
    assert.equal(x.text, 'ok: [2] as text\n[2] form\n  [3] searchbox "Search"  empty\n  [4] button "Go"');
    const missing = await mcp.call("read", { id: 404 });
    assert.match(missing.text, /^failed: no element \[404\]/);
  });

  test("screenshot returns a JPEG image; an older API says so", async () => {
    const r = await mcp.call("screenshot", {});
    assert.equal(r.content[0].type, "image");
    assert.equal(r.content[0].mimeType, "image/jpeg");
    assert.equal(r.content[0].data, "/9j/4AAQ");
    assert.match(r.text, /^ok: viewport, 1280x720, scale 1/);
    assert.deepEqual(api.last("/v1/agents/agt_1/observe").body, { screenshot: {}, session: "pv_a" });
    await mcp.call("screenshot", { full: true });
    assert.deepEqual(api.last("/v1/agents/agt_1/observe").body.screenshot, { full: true });
    const gone = await mcp.call("screenshot", { id: 99 });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /ELEMENT_NOT_VISIBLE/);
    api.state.oldServer = true;
    const old = await mcp.call("screenshot", {});
    api.state.oldServer = false;
    assert.equal(old.isError, true);
    assert.match(old.text, /cannot take screenshots yet/);
  });

  test("secrets lists names, kinds, sites and refs, never values", async () => {
    const r = await mcp.call("secrets");
    assert.equal(r.text.split("\n")[0], 'secrets: 3 (values are never shown; type one with act {action: "type", id, secret: REF})');
    assert.ok(r.text.includes('GITHUB  login  on github.com and subdomains  refs GITHUB:username, GITHUB:password, TOTP:GITHUB  one-time code  "release bot"'));
    assert.ok(r.text.includes("STRIPE_KEY  value  on any https site  refs STRIPE_KEY"));
    assert.ok(r.text.includes("OLD_PIN  value  on no sites yet"));
    assert.ok(!r.text.includes("re…"), "masked username is not needed");
    api.state.noSecrets = true;
    const off = await mcp.call("secrets");
    api.state.noSecrets = false;
    assert.match(off.text, /^secrets: not available on this Browsa server yet/);
  });

  test("handoff mints a single-use control link; the next observe says when the person is done", async () => {
    api.state.challenge = "turnstile";
    const h = await mcp.call("handoff", { reason: "solve the captcha" });
    assert.deepEqual(api.last("/v1/agents/agt_1/live").body, { scope: "control", ttl_seconds: 600 });
    assert.match(h.text, /^waiting: give this link to the person \(single use, control, expires 2026-11-19T12:30:00Z\):\nhttps:\/\/browsa\.io\/live\?agent=agt_1#c=lc_ctl\.mac\nreason: solve the captcha/);
    const still = await mcp.call("observe", {});
    assert.match(still.text, /^handoff: still waiting for the person/);
    api.state.challenge = undefined;
    const done = await mcp.call("observe", {});
    assert.match(done.text, /^handoff: done \(the turnstile check is gone\)/);
    const after = await mcp.call("observe", {});
    assert.ok(!after.text.startsWith("handoff:"));

    // wait_s polls until the page changes (the mock moves on at the 3rd read)
    api.state.flipAt = api.state.observes + 3;
    const t0 = Date.now();
    const w = await mcp.call("handoff", { reason: "log in", wait_s: 30, scope: "view" });
    assert.equal(api.last("/v1/agents/agt_1/live").body.scope, "view");
    assert.ok(Date.now() - t0 < 5000, "wait_s did not stop when the page changed");
    assert.match(w.text, /\nhandoff: done \(the page is now https:\/\/books\.example\/account\)/);
  });

  test("flow: record act and read, save as a recipe with params and secret tokens, run with no model", async () => {
    api.state.url = "https://books.example/";
    const s = await mcp.call("flow", { op: "start" });
    assert.match(s.text, /^recording: every act and read on agt_1/);
    await mcp.call("act", { action: "type", id: 3, text: "poetry", submit: true });
    assert.equal(api.last("/v1/agents/agt_1/act").body.record, true);
    await mcp.call("act", { action: "click", id: 4 });
    await mcp.call("act", { action: "type", id: 3, secret: "GITHUB:password" });
    await mcp.call("act", { action: "click", x: 10, y: 10 });
    await mcp.call("read", { id: 5, as: "table" });
    const saved = await mcp.call("flow", { op: "save", name: "Book Search", params: { query: "poetry" } });
    assert.match(saved.text, /^ok: saved flow book-search \(v1, 5 steps, 9 credits per successful run, id rec_1\)/);
    assert.match(saved.text, /note: click at a point not recorded/);
    const recipe = api.state.savedRecipe.recipe;
    assert.equal(api.state.savedRecipe.name, "book-search");
    assert.deepEqual(recipe.params, { type: "object", properties: { query: { type: "string" } }, required: ["query"] });
    assert.deepEqual(recipe.steps.map((x) => x.kind), ["navigate", "type", "click", "type", "extract"]);
    assert.equal(recipe.steps[0].url, "https://books.example/");
    assert.equal(recipe.steps[1].text, "{{query}}");
    assert.deepEqual(recipe.steps[1].target, { role: "searchbox", name: "Search", css: "#e3" });
    assert.equal(recipe.steps[3].text, "{{secret:GITHUB:password}}");
    assert.ok(!JSON.stringify(recipe).includes("poetry"), "the example value stayed in the recipe");
    assert.deepEqual(recipe.steps[4].how, { css: "#prices tbody tr", fields: { title: ":scope > :nth-child(1)", price: ":scope > :nth-child(2)" }, into: "read_1", allow_empty: true });
    assert.deepEqual(recipe.output.properties, { read_1: { type: "array" } });

    const again = await mcp.call("flow", { op: "save", name: "x" });
    assert.match(again.text, /nothing is being recorded/);

    const run = await mcp.call("flow", { op: "run", name: "book-search", params: { query: "travel" }, version: 1 });
    assert.deepEqual(api.state.runBody, { params: { query: "travel" }, wait: 60, version: 1 });
    assert.match(run.text, /^ok: flow book-search v1 ran in 4\.1 s, no model calls, 9 credits\n/);

    api.state.runFails = true;
    const broken = await mcp.call("flow", { op: "run", name: "book-search", params: { query: "travel" } });
    assert.match(broken.text, /^site_changed: flow book-search v1 failed at a step the site no longer has\nstep: \{"step":"s2","ok":false,"error":"no button Go"\}/);
    assert.match(broken.text, /next: open the page, flow start, redo the steps with act, flow save/);

    const list = await mcp.call("flow", { op: "list" });
    assert.match(list.text, /^flows: 1\nbook-search  v1  9 credits per run  id rec_1$/);
  });

  test("close stops the browser; a gone browser says to call open", async () => {
    const r = await mcp.call("close", {});
    assert.equal(r.text, "ok: closed agt_1");
    assert.equal(api.last("/v1/agents/agt_1").method, "DELETE");
    const after = await mcp.call("observe", {});
    assert.match(after.text, /call open first/);
    const gone = await mcp.call("observe", { browser_id: "agt_gone" });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /^error: AGENT_NOT_RUNNING: agent is destroyed\nnext: this browser is gone \(it expired or was closed\); call open for a new one$/);
  });

  test("nothing was written to the working directory", () => {
    assert.deepEqual(fs.readdirSync(cwd), []);
  });
});
