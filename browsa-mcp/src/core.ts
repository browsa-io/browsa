// The nine core tools: open, observe, act, read, screenshot, secrets,
// handoff, flow, close. Small schemas; answers are plain text whose first
// line says what happened and, when something stopped, what to do next.

import { apiDelete, apiGet, apiPost, BrowsaError } from "./api.js";
import { DEFAULT_COUNTRY, KEYS_URL } from "./config.js";
import { buildRecipe, flowName, newRecording, recordAct, recordRead, type Recording, type Target } from "./flow.js";
import { elementsOf, type ElementRef, findInView, subtreeLines, tokensOf } from "./viewtext.js";

// ── Schemas ─────────────────────────────────────────────────────────────

const BID = { type: "string", description: "Default: the last browser used." } as const;
const ACTIONS = ["click", "type", "press", "select", "check", "uncheck", "hover", "scroll", "navigate", "back", "forward", "reload", "wait", "upload", "dialog", "press_and_hold", "solve_captcha"];

export const DEFAULT_BUDGET = 1500;
export const MAX_BUDGET = 6000;
export const DIFF_MAX_TOKENS = 400;

export const coreTools = [
  {
    name: "open",
    description: "Open a cloud browser (Phantom) and go to url. Returns the browser id, a live view link and the first view. Close it when done.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        where: { type: "string", enum: ["cloud"] },
        country: { type: "string", description: "Exit country, e.g. us. Needs a proxy." },
        profile: { type: "string", description: "Saved identity id: keeps its cookies and logins." },
        proxy: { type: "object", description: "{network: datacenter|residential, country?} or your own {server, username?, password?}." },
        ttl: { type: "string", description: "e.g. 10m (default), 1h." },
      },
    },
  },
  {
    name: "observe",
    description: "The page as text: one line per element, [id] role \"name\" state. Use ids with act. find returns only the matching lines.",
    inputSchema: {
      type: "object",
      properties: {
        browser_id: BID,
        scope: { type: "string", enum: ["viewport", "page"] },
        budget: { type: "integer", description: "Tokens, default 1500, max 6000." },
        expand: { type: "integer", description: "Container id to list in full." },
        find: { type: "string", description: "Text or /regex/ to look for on the whole page." },
        tab: { type: "string" },
      },
    },
  },
  {
    name: "act",
    description: "One action with real input. Answers what changed or a fresh view. First line: ok, failed, blocked, challenge, stale, dialog or secret_origin.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        browser_id: BID,
        action: { type: "string", enum: ACTIONS },
        id: { type: "integer" },
        role: { type: "string", description: "With name: the element by role and name, instead of id." },
        name: { type: "string" },
        x: { type: "number", description: "click at a viewport point, with y." },
        y: { type: "number" },
        text: { type: "string", description: "type: text. wait: text to wait for. dialog: prompt answer." },
        secret: { type: "string", description: "type: a saved secret instead of text, e.g. NAME:password, TOTP:NAME. Never shown." },
        clear: { type: "boolean" },
        submit: { type: "boolean", description: "type: press Enter after." },
        keys: { type: "string", description: "press: Enter, Control+A, \"Tab Tab Enter\"." },
        option: { type: "string", description: "select: option text or value." },
        double: { type: "boolean" },
        right: { type: "boolean" },
        dy: { type: "integer", description: "scroll: pixels, + is down." },
        to: { type: "string", enum: ["top", "bottom"] },
        url: { type: "string" },
        ms: { type: "integer" },
        for: { type: "string", enum: ["text", "id-gone", "url-change"] },
        timeout: { type: "integer" },
        files: { type: "array", items: { type: "string" } },
        accept: { type: "boolean", description: "dialog: accept or dismiss." },
        tab: { type: "string" },
      },
    },
  },
  {
    name: "read",
    description: "The full content of one container by id, with no model: text, a table as TSV, or links.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { browser_id: BID, id: { type: "integer" }, as: { type: "string", enum: ["text", "table", "links"] } },
    },
  },
  {
    name: "screenshot",
    description: "JPEG of the viewport (pixels / scale = act x,y), the full page, or one element.",
    inputSchema: { type: "object", properties: { browser_id: BID, id: { type: "integer" }, full: { type: "boolean" } } },
  },
  {
    name: "secrets",
    description: "Saved secrets: names, kinds, the sites they may be typed on, one-time-code flag. Never values. Type one with act secret.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "handoff",
    description: "A single-use live link for a person to take over (captcha, login, a decision). The next observe or act says when they are done.",
    inputSchema: {
      type: "object",
      required: ["reason"],
      properties: {
        browser_id: BID,
        reason: { type: "string" },
        scope: { type: "string", enum: ["control", "view"] },
        wait_s: { type: "integer", description: "Wait up to this long (max 900) for the page to change." },
      },
    },
  },
  {
    name: "flow",
    description: "Record act and read steps (start), save them (save), replay with no model (run), list. A broken step answers site_changed.",
    inputSchema: {
      type: "object",
      required: ["op"],
      properties: {
        op: { type: "string", enum: ["start", "save", "run", "list"] },
        name: { type: "string" },
        params: { type: "object", description: "save: {param: example value typed}. run: {param: value}." },
        version: { type: "integer" },
        browser_id: BID,
      },
    },
  },
  {
    name: "close",
    description: "Close a browser and stop its billing.",
    inputSchema: { type: "object", properties: { browser_id: BID } },
  },
];

// ── State (memory only) ─────────────────────────────────────────────────

type Handoff = { link: string; expiresAt: string; reason: string; at: number; url: string; challenge: string; title: string };

type BrowserState = {
  id: string;
  last: string; // last tab used
  sessions: Map<string, string>; // tab -> view session
  elements: Map<string, Map<number, ElementRef>>; // tab -> id -> role/name
  url: string;
  title: string;
  handoff?: Handoff;
  recording?: Recording;
};

const browsers = new Map<string, BrowserState>();
let lastBrowser: string | undefined;

function stateOf(id: string): BrowserState {
  let b = browsers.get(id);
  if (!b) {
    b = { id, last: "", sessions: new Map(), elements: new Map(), url: "", title: "" };
    browsers.set(id, b);
  }
  return b;
}

/** Thrown for a tool call that cannot go on; the message is the answer. */
export class ToolError extends Error {}

function browserOf(args: Record<string, any>): BrowserState {
  const id = String(args.browser_id || lastBrowser || "");
  if (!id) throw new ToolError("error: no browser yet\nnext: call open first");
  lastBrowser = id;
  return stateOf(id);
}

function forget(id: string) {
  browsers.delete(id);
  if (lastBrowser === id) lastBrowser = undefined;
}

// ── Errors that say what to do next ─────────────────────────────────────

export function explain(e: unknown, tool: string, browserId?: string): string {
  if (e instanceof ToolError) return e.message;
  if (!(e instanceof BrowsaError)) {
    const msg = (e as Error)?.name === "TimeoutError" ? "the API did not answer in time" : (e as Error)?.message || String(e);
    return `error: ${msg}\nnext: try again; if it keeps failing, observe to see the page`;
  }
  const code = e.code || "";
  const head = `error: ${code ? code + ": " : ""}${e.message}`;
  const next = (s: string) => `${head}\nnext: ${s}`;
  switch (true) {
    case code === "AGENT_NOT_RUNNING" || (code === "NOT_FOUND" && /agent/i.test(e.message)):
      if (browserId) forget(browserId);
      return next("this browser is gone (it expired or was closed); call open for a new one");
    case code === "BROWSER_BUSY":
      return next("another call is still running on this browser; retry in a few seconds");
    case code === "BROWSER_UNREACHABLE":
      return tool === "act"
        ? next("the connection dropped during the action, so it may or may not have happened; call observe before acting again")
        : next("the browser could not be reached; retry, or close it and open a new one");
    case code === "TAB_NOT_FOUND":
      return next("that tab is closed; observe without tab lists the open tabs");
    case code === "DIALOG_OPEN":
      return next("a dialog is open; call act with action dialog and accept true or false first");
    case code === "STALE":
      return next("the page changed; call observe and use the new ids");
    case e.status === 401 || code === "INVALID_API_KEY" || code === "MISSING_API_KEY":
      return next(`BROWSA_API_KEY was refused; mint a key at ${KEYS_URL} and restart the server`);
    case e.status === 402 || /CREDIT/.test(code):
      return next("not enough credits; top up at https://app.browsa.io/dashboard/billing");
    case e.status === 429:
      return next("too many requests; wait a little and retry");
    case code === "SECRETS_UNAVAILABLE":
      return next("secrets are not enabled on this Browsa server yet; type the text yourself or call handoff");
    case code === "SECRET_NOT_FOUND":
      return next("call secrets for the saved names");
    case code === "SECRET_REF_INVALID":
      return next("use one of the refs that secrets lists, e.g. NAME:password or TOTP:NAME");
    case code === "CAPTCHA_UNAVAILABLE":
      return next("captcha solving is off here; call handoff so a person can solve it");
    case code === "REPLAY_UNAVAILABLE":
      return next("flows are not switched on for this workspace yet; keep using act");
    case e.status === 404 && tool === "handoff":
      return next("live links are not on for this workspace; ask the person to open the dashboard's live view");
    case e.status === 404 && tool === "screenshot":
      return next("that element is gone; observe and use a current id");
  }
  return e.requestId ? `${head} (request ${e.requestId})` : head;
}

// ── The page view API ───────────────────────────────────────────────────

async function pageCall(b: BrowserState, route: "observe" | "act", body: Record<string, any>): Promise<any> {
  const tab = body.tab ?? b.last;
  const session = tab ? b.sessions.get(tab) : undefined;
  if (session) body.session = session;
  const r = await apiPost(`/v1/agents/${encodeURIComponent(b.id)}/${route}`, body, 120_000);
  if (r?.tab && r?.session) {
    b.last = r.tab;
    b.sessions.set(r.tab, r.session);
  }
  if (typeof r?.url === "string") b.url = r.url;
  if (typeof r?.title === "string") b.title = r.title;
  const t = r?.tab ?? tab ?? "";
  let els = b.elements.get(t);
  if (!els || r?.ids_reset || r?.fresh_view === "new page" || r?.navigation && !r.navigation.same_document) {
    els = new Map();
    b.elements.set(t, els);
  }
  if (typeof r?.text === "string") for (const [id, e] of elementsOf(r.text)) els.set(id, e);
  return r;
}

function tabsLine(r: any): string {
  if (!Array.isArray(r?.tabs) || r.tabs.length < 2) return "";
  return "\ntabs: " + r.tabs.map((t: any) => `${t.id} ${JSON.stringify(t.title || t.url || "")}${t.active ? " (this one)" : ""}`).join(" | ");
}

/** The hand-off line for an answer about the page, and whether the person is done. */
function handoffLine(b: BrowserState, r: any): string {
  const h = b.handoff;
  if (!h) return "";
  const challenge = r?.challenge?.kind ?? (r?.state === "challenge" ? "challenge" : "");
  // A page that moved on (a login that went through) or a check that is gone.
  // The title is not compared: many pages change it on their own.
  const done = (r?.url && r.url !== h.url) || (h.challenge && !challenge);
  if (done) {
    b.handoff = undefined;
    const why = h.challenge && !challenge ? `the ${h.challenge} check is gone` : r?.url !== h.url ? `the page is now ${r.url}` : "the page changed";
    return `handoff: done (${why}); the person has finished, carry on from this page\n`;
  }
  const mins = Math.max(1, Math.round((Date.now() - h.at) / 60000));
  return `handoff: still waiting for the person (link sent ${mins} min ago, expires ${h.expiresAt}); acting now may get in their way\n`;
}

// ── open ────────────────────────────────────────────────────────────────

async function open(args: Record<string, any>): Promise<string> {
  if (args.where && args.where !== "cloud") throw new ToolError("error: only cloud browsers for now\nnext: call open without where");
  const body: Record<string, unknown> = { ttl: args.ttl || "10m" };
  const country = args.country ?? DEFAULT_COUNTRY;
  if (country) body.country = country;
  if (args.profile) body.agent_id = args.profile;
  if (args.proxy) body.proxy = args.proxy;
  const a = await apiPost("/v1/agents", body, 120_000);
  const id = String(a.id);
  const b = stateOf(id);
  lastBrowser = id;
  const egress = args.proxy?.network ? `Browsa ${args.proxy.network} proxy` : args.proxy ? "your proxy" : "Browsa's address";
  // No credit number here: the create answer's figure is not what the browser ends up costing
  // (live 2026-11-19: it said 5, the balance moved by 1 after close).
  const head = [`ok: browser ${id} is open (Phantom, cloud, ${egress}), expires ${a.expires_at ?? "with its ttl"}; close it when done`];
  if (a.live_url) head.push(`live view (single use, for a person): ${a.live_url}`);
  if (!args.url) {
    head.push("the page is blank; next: act with action navigate and a url");
    return head.join("\n");
  }
  try {
    const r = await pageCall(b, "act", { action: "navigate", url: String(args.url) });
    let view = String(r.text ?? "");
    if (tokensOf(view) > DEFAULT_BUDGET * 1.1) view = String((await pageCall(b, "observe", { budget: DEFAULT_BUDGET })).text ?? view);
    return `${head.join("\n")}\n${statusLine(r)}\n${stripStatus(view)}${tabsLine(r)}`;
  } catch (e) {
    return `${head.join("\n")}\n${explain(e, "act", id)}`;
  }
}

// ── observe ─────────────────────────────────────────────────────────────

function clampBudget(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BUDGET;
  return Math.min(Math.max(n, 100), MAX_BUDGET);
}

async function observe(args: Record<string, any>): Promise<string> {
  const b = browserOf(args);
  const body: Record<string, unknown> = {};
  if (args.tab) body.tab = args.tab;
  if (args.expand) body.expand = Number(args.expand);
  if (typeof args.find === "string" && args.find.trim()) {
    body.scope = "page";
    body.budget = -1;
    const r = await pageCall(b, "observe", body);
    return handoffLine(b, r) + findInView(String(r.text ?? ""), args.find) + tabsLine(r);
  }
  if (args.scope) body.scope = args.scope;
  body.budget = clampBudget(args.budget);
  const r = await pageCall(b, "observe", body);
  return handoffLine(b, r) + String(r.text ?? "") + tabsLine(r);
}

// ── act ─────────────────────────────────────────────────────────────────

const STATUS_PREFIX = /^(failed|blocked|challenge|secret_origin|stale|not solved|solved): /;

/** The engine's text without its own status line (the first line says it). */
function stripStatus(text: string): string {
  return text.split("\n").filter((l) => !STATUS_PREFIX.test(l)).join("\n");
}

function statusLine(r: any): string {
  const status = String(r?.status ?? "ok");
  const reason = r?.reason ? String(r.reason) : "";
  if (r?.dialog && (status === "ok" || status === "blocked")) {
    const d = r.dialog;
    const what = d?.message ? ` (${d.type ?? "dialog"}: ${JSON.stringify(String(d.message).slice(0, 120))})` : "";
    return `dialog: a dialog is open${what}; next: act with action dialog and accept true or false`;
  }
  switch (status) {
    case "ok": return "ok";
    case "stale": return "stale: the page changed and those ids are gone; nothing was done. Fresh view:";
    case "failed":
      if (/unknown id|element gone|no element with role/.test(reason)) return `failed: ${reason}; next: use an id from this view, or observe`;
      return `failed: ${reason}`;
    case "blocked": return `blocked: ${reason}; next: close what covers it (click it, or press Escape) and retry`;
    case "challenge": return `challenge: ${reason}; next: act solve_captcha, and if it stays, handoff`;
    case "secret_origin": return `secret_origin: ${reason}; next: check the page, secrets lists where each secret may be typed`;
  }
  return reason ? `${status}: ${reason}` : status;
}

async function act(args: Record<string, any>): Promise<string> {
  const b = browserOf(args);
  const { browser_id: _drop, ...body } = args;
  if (typeof body.action !== "string") throw new ToolError("error: action is required\nnext: e.g. {\"action\": \"click\", \"id\": 12}");
  const rec = b.recording;
  if (rec) body.record = true;
  const before = b.elements.get(String(args.tab ?? b.last));
  const r = await pageCall(b, "act", body);
  const status = String(r?.status ?? "ok");
  const hand = handoffLine(b, r);
  if (body.secret && status === "ok" && !r?.secret) {
    // An API without secret typing ignores the field: it focused the field and typed nothing.
    return hand + "failed: this Browsa server cannot type secrets yet, so nothing was typed\n" +
      "next: type the value with text if the person gave it to you, or call handoff so they can type it";
  }

  if (body.action === "solve_captcha") {
    const lines = String(r.text ?? "").split("\n");
    const first = lines.shift() ?? "";
    const head = status === "ok" ? `ok: captcha ${first}` : `failed: captcha ${first}; next: call handoff so a person can solve it`;
    return hand + head + "\n" + lines.join("\n") + tabsLine(r);
  }

  let text = stripStatus(String(r.text ?? ""));
  // A diff over the cap, or a fresh view over the budget: a view inside the budget instead.
  if (status === "ok" && !r.dialog) {
    const fresh = !!r.fresh_view;
    if ((!fresh && tokensOf(text) > DIFF_MAX_TOKENS) || (fresh && tokensOf(text) > DEFAULT_BUDGET * 1.1)) {
      const echo = text.split("\n")[0];
      const v = await pageCall(b, "observe", { budget: DEFAULT_BUDGET, ...(args.tab ? { tab: args.tab } : {}) });
      text = `${echo}\n${fresh ? "fresh view" : "large change, fresh view"}:\n${v.text ?? ""}`;
    }
  }

  let note = "";
  if (rec && status === "ok") {
    const t: Target | undefined = r.target ?? (args.id ? before?.get(Number(args.id)) : undefined) ??
      (args.role || args.name ? { role: args.role, name: args.name } : undefined);
    const n = recordAct(rec, body, t, String(r.url ?? b.url), r.secret ?? args.secret);
    if (n) note = `\nflow: ${n}`;
  }
  return hand + statusLine(r) + "\n" + text + tabsLine(r) + note;
}

// ── read ────────────────────────────────────────────────────────────────

function tsv(cells: unknown[]): string {
  return cells.map((c) => String(c ?? "").replace(/[\t\r\n]+/g, " ")).join("\t");
}

async function read(args: Record<string, any>): Promise<string> {
  const b = browserOf(args);
  const id = Math.floor(Number(args.id));
  if (!id) throw new ToolError("error: id is required\nnext: an id of a container from observe");
  const as = ["text", "table", "links"].includes(args.as) ? args.as : "text";
  const r = await pageCall(b, "observe", { expand: id, scope: "page", budget: -1, json: true, selector: true });
  const text = String(r.text ?? "");
  if (/^note: expand was ignored/m.test(text)) {
    return "stale: the page changed and that id is gone. Fresh view:\n" + text.replace(/^note: .*\n/, "");
  }
  const els: any[] = Array.isArray(r.view?.elements) ? r.view.elements : [];
  const parent = new Map<number, number>();
  for (const e of els) if (e?.id) parent.set(e.id, e.parent ?? 0);
  const inside = (e: any): boolean => {
    let p = e?.parent ?? 0;
    for (let i = 0; p && i < 200; i++) { if (p === id) return true; p = parent.get(p) ?? 0; }
    return false;
  };
  let out = "";
  let headers: string[] = [];
  if (as === "table") {
    const rows = els.filter((e) => e?.kind === "row" && (inside(e) || e.parent === id));
    const head = rows.find((e) => e.header);
    headers = head ? head.cells ?? [] : [];
    out = rows.map((e) => tsv(e.cells ?? [])).join("\n");
    if (!rows.length) out = "(no table rows in that element; try as text)";
  } else if (as === "links") {
    const links = els.filter((e) => e?.role === "link" && (inside(e) || e.id === id));
    out = links.map((e) => tsv([e.name ?? "", e.state?.href ?? ""])).join("\n");
    if (!links.length) out = "(no links in that element)";
  } else {
    out = subtreeLines(text, id);
    if (!out) {
      return `failed: no element [${id}] in the current view; next: observe and use a current id`;
    }
  }
  const MAX = 24_000;
  if (out.length > MAX) out = out.slice(0, MAX) + `\n… cut at ${MAX} characters`;
  let note = "";
  if (b.recording) {
    const res = recordRead(b.recording, as, String(r.selector ?? ""), headers);
    note = res.into ? `\nflow: recorded as ${res.into}` : `\nflow: ${res.note}`;
  }
  return `ok: [${id}] as ${as}\n${out}${note}`;
}

// ── screenshot ──────────────────────────────────────────────────────────

async function screenshot(args: Record<string, any>): Promise<{ text: string; image?: { data: string; mime: string } }> {
  const b = browserOf(args);
  const shot: Record<string, unknown> = {};
  if (args.full) shot.full = true;
  if (args.id) shot.id = Number(args.id);
  const r = await pageCall(b, "observe", { screenshot: shot });
  const s = r?.screenshot;
  if (!s?.data) {
    throw new ToolError("error: this Browsa server cannot take screenshots yet\nnext: use observe; screenshots come with the next API release");
  }
  const what = args.id ? `element [${args.id}]` : args.full ? "full page" : "viewport";
  let text = `ok: ${what}, ${s.width}x${s.height}`;
  if (!args.id && !args.full) text += `, scale ${s.scale}: act x = pixel x / ${s.scale}`;
  if (s.truncated) text += " (cut at the first 6000 px of the page)";
  return { text, image: { data: s.data, mime: s.mime || "image/jpeg" } };
}

// ── secrets ─────────────────────────────────────────────────────────────

function where(origins: string[]): string {
  // No sites: typed nowhere until they are set; ["*"]: the any-site opt-in.
  if (!origins?.length) return "no sites yet (set them on the Secrets page; it can not be typed)";
  if (origins.length === 1 && origins[0] === "*") return "any https site";
  return origins.map((o) => {
    const h = o.replace(/^https:\/\//, "");
    return h.startsWith("*.") ? `${h.slice(2)} and subdomains` : h;
  }).join(", ");
}

async function secrets(): Promise<string> {
  let body: any;
  try {
    body = await apiGet("/v1/secrets");
  } catch (e) {
    if (e instanceof BrowsaError && (e.status === 404 || e.status === 503 || e.status === 405)) {
      return "secrets: not available on this Browsa server yet\nnext: type values yourself, or call handoff for a login";
    }
    throw e;
  }
  const list: any[] = Array.isArray(body?.secrets) ? body.secrets : [];
  if (!list.length) return "secrets: none saved\nnext: save logins and keys at https://app.browsa.io (Secrets); values never pass through here";
  const lines = [`secrets: ${list.length} (values are never shown; type one with act {action: "type", id, secret: REF})`];
  for (const s of list) {
    const refs = Array.isArray(s.placeholders) ? s.placeholders.join(", ") : s.name;
    let line = `${s.name}  ${s.type}  on ${where(s.origins)}  refs ${refs}`;
    if (s.has_totp) line += "  one-time code";
    if (s.description) line += `  ${JSON.stringify(String(s.description).slice(0, 120))}`;
    lines.push(line);
  }
  return lines.join("\n");
}

// ── handoff ─────────────────────────────────────────────────────────────

async function handoff(args: Record<string, any>): Promise<string> {
  const b = browserOf(args);
  const reason = String(args.reason ?? "").trim();
  if (!reason) throw new ToolError("error: reason is required\nnext: say what the person should do, e.g. \"solve the captcha\"");
  const scope = args.scope === "view" ? "view" : "control";
  const waitS = Math.min(Math.max(Math.floor(Number(args.wait_s) || 0), 0), 900);
  const base = await pageCall(b, "observe", { budget: 200 });
  const link = await apiPost(`/v1/agents/${encodeURIComponent(b.id)}/live`, { scope, ttl_seconds: Math.min(Math.max(waitS + 600, 300), 3600) });
  b.handoff = {
    link: link.live_url, expiresAt: link.expires_at ?? "", reason, at: Date.now(),
    url: String(base.url ?? b.url), challenge: base.challenge?.kind ?? (base.state === "challenge" ? "challenge" : ""), title: String(base.title ?? ""),
  };
  const head = `waiting: give this link to the person (single use, ${scope}, expires ${link.expires_at ?? "soon"}):\n${link.live_url}\nreason: ${reason}`;
  if (!waitS) return `${head}\nnext: the next observe or act says when the page changed (they are done)`;
  const deadline = Date.now() + waitS * 1000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, Math.min(HANDOFF_POLL_MS, Math.max(0, deadline - Date.now()))));
    const r = await pageCall(b, "observe", { budget: DEFAULT_BUDGET });
    const line = handoffLine(b, r);
    if (line.startsWith("handoff: done")) return `${head}\n${line}${r.text ?? ""}`;
  }
  return `${head}\nhandoff: still waiting after ${waitS}s\nnext: ask the person, then observe`;
}
const HANDOFF_POLL_MS = Number(process.env.BROWSA_HANDOFF_POLL_MS) || 3000;

// ── flow ────────────────────────────────────────────────────────────────

const RUN_DONE = new Set(["ok", "failed", "cancelled"]);
const FLOW_POLL_S = Number(process.env.BROWSA_FLOW_WAIT_S) || 60;

async function findFlow(name: string): Promise<any | undefined> {
  const body = await apiGet("/v1/recipes?limit=200");
  const list: any[] = Array.isArray(body?.recipes) ? body.recipes : [];
  return list.find((r) => r.name === name && r.status !== "draft");
}

function failingStep(run: any): string {
  const layers = Array.isArray(run?.layers) ? run.layers : Array.isArray(run?.layers?.steps) ? run.layers.steps : [];
  const bad = layers.find((l: any) => l && (l.ok === false || l.error || l.status === "failed"));
  if (!bad) return "";
  const s = JSON.stringify(bad);
  return s.length > 300 ? s.slice(0, 297) + "..." : s;
}

async function flow(args: Record<string, any>): Promise<string> {
  const op = String(args.op ?? "");
  if (op === "list") {
    const body = await apiGet("/v1/recipes?limit=200");
    const list: any[] = (Array.isArray(body?.recipes) ? body.recipes : []).filter((r: any) => r.status !== "draft");
    if (!list.length) return "flows: none saved\nnext: flow start, then act and read, then flow save";
    return [`flows: ${list.length}`, ...list.map((r) => `${r.name}  v${r.current_version ?? "?"}  ${r.price_credits} credits per run  id ${r.id}`)].join("\n");
  }
  if (op === "start") {
    const b = browserOf(args);
    // where the page is now (a person may have moved it)
    await pageCall(b, "observe", { budget: 100 });
    b.recording = newRecording(b.url);
    return `recording: every act and read on ${b.id} from now on (starting at ${b.url || "a blank page"})\nnext: do the task with act and read, then flow {op: "save", name, params: {param: example value}}`;
  }
  if (op === "save") {
    const b = browserOf(args);
    const rec = b.recording;
    if (!rec) throw new ToolError("error: nothing is being recorded\nnext: flow {op: \"start\"} first");
    const name = flowName(args.name);
    if (!name) throw new ToolError("error: name is required\nnext: e.g. flow {op: \"save\", name: \"book-search\"}");
    if (!rec.steps.length) throw new ToolError("error: no steps recorded yet\nnext: do the task with act and read first");
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.params ?? {})) {
      const key = String(k).toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (key && v !== undefined && v !== null && String(v) !== "") params[key] = String(v);
    }
    if (await findFlow(name)) throw new ToolError(`error: a flow named ${name} exists\nnext: pick another name`);
    const recipe = buildRecipe(rec, name, params);
    const saved = await apiPost("/v1/recipes", { recipe, name });
    b.recording = undefined;
    const lines = [`ok: saved flow ${name} (v${saved.current_version ?? 1}, ${(recipe.steps as unknown[]).length} steps, ${saved.price_credits} credits per successful run, id ${saved.id})`];
    const example = Object.keys(params).length ? `, params: ${JSON.stringify(Object.fromEntries(Object.keys(params).map((p) => [p, "..."])))}` : "";
    lines.push(`run it: flow {op: "run", name: "${name}"${example}}`);
    if (rec.notes.length) lines.push(...rec.notes.slice(0, 10).map((n) => `note: ${n}`));
    return lines.join("\n");
  }
  if (op === "run") {
    const name = flowName(args.name);
    if (!name) throw new ToolError("error: name is required\nnext: flow {op: \"list\"} shows the names");
    const f = await findFlow(name);
    if (!f) throw new ToolError(`error: no flow named ${name}\nnext: flow {op: "list"}`);
    const body: Record<string, unknown> = { params: args.params ?? {}, wait: FLOW_POLL_S };
    if (args.version) body.version = Number(args.version);
    let run = await apiPost(`/v1/recipes/${encodeURIComponent(f.id)}/run`, body, (FLOW_POLL_S + 30) * 1000);
    const deadline = Date.now() + 4 * FLOW_POLL_S * 1000;
    while (!RUN_DONE.has(run?.status) && Date.now() < deadline) {
      run = await apiGet(`/v1/recipe-runs/${encodeURIComponent(run.id)}?wait=${FLOW_POLL_S}`, (FLOW_POLL_S + 30) * 1000);
    }
    const secs = run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)} s` : "";
    const pinNote = args.version && run.version && Number(args.version) !== Number(run.version)
      ? `\nnote: v${args.version} was asked, this server ran v${run.version} (pinning a version needs a newer API)` : "";
    if (run.status === "ok") {
      return `ok: flow ${name} v${run.version} ran${secs ? " in " + secs : ""}, no model calls, ${run.credits ?? 0} credits${pinNote}\n${JSON.stringify(run.output ?? {}, null, 1)}`;
    }
    if (!RUN_DONE.has(run?.status)) return `running: flow ${name} is still running (run ${run.id})\nnext: flow run again later, or check the dashboard`;
    const code = run.error_code || run.status;
    const step = failingStep(run);
    if (code === "site_changed") {
      return `site_changed: flow ${name} v${run.version} failed at a step the site no longer has${step ? `\nstep: ${step}` : ""}\n${run.error_message ?? ""}\nnext: open the page, flow start, redo the steps with act, flow save under a new name (failed runs are free)`;
    }
    return `failed: ${code}: ${run.error_message ?? ""}${step ? `\nstep: ${step}` : ""}\nnext: failed runs are free; check the params, or redo the task with act`;
  }
  throw new ToolError("error: op must be start, save, run or list");
}

// ── close ───────────────────────────────────────────────────────────────

async function close(args: Record<string, any>): Promise<string> {
  const b = browserOf(args);
  const dropped = b.recording ? " (the unsaved recording was dropped)" : "";
  try {
    await apiDelete(`/v1/agents/${encodeURIComponent(b.id)}`);
  } catch (e) {
    if (!(e instanceof BrowsaError && (e.status === 404 || e.code === "AGENT_NOT_RUNNING"))) throw e;
  }
  forget(b.id);
  return `ok: closed ${b.id}${dropped}`;
}

// ── dispatch ────────────────────────────────────────────────────────────

export type CoreAnswer = { text: string; image?: { data: string; mime: string }; isError?: boolean };

export async function callCore(name: string, args: Record<string, any>): Promise<CoreAnswer> {
  const browserId = args.browser_id || lastBrowser;
  try {
    switch (name) {
      case "open": return { text: await open(args) };
      case "observe": return { text: await observe(args) };
      case "act": return { text: await act(args) };
      case "read": return { text: await read(args) };
      case "screenshot": return await screenshot(args);
      case "secrets": return { text: await secrets() };
      case "handoff": return { text: await handoff(args) };
      case "flow": return { text: await flow(args) };
      case "close": return { text: await close(args) };
    }
  } catch (e) {
    return { text: explain(e, name, browserId), isError: true };
  }
  return { text: `error: unknown tool ${name}`, isError: true };
}

/** For tests: forget every browser. */
export function resetState() {
  browsers.clear();
  lastBrowser = undefined;
}
