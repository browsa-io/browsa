// Finds captchas in a page's HTML. Pure text work: no network, no DOM, no key.
//
// The rules are the ones Browsa's browser extension uses in the page: a
// captcha counts when its provider is really there (a widget element with a
// site key, a frame or a script from the provider's own host, or the
// provider's start call in a script). Words in the text, code samples and
// class names alone never count: any page can write the word "captcha".
//
// Site keys are read from frame addresses first (what the live widget asked
// for), then from the widget's markup, then from the page's scripts.

export interface Finding {
  /** The catalogue's family, e.g. "turnstile", or a provider slug when the API has no type for it. */
  kind: string;
  /** The provider's own name. */
  name: string;
  /** createTask parameters read from the page. */
  params: Record<string, unknown>;
  /** What the page wants back: used to build the apply expression. */
  page: { callback?: string; responseField?: string };
  /** Required parameters the HTML did not give, each with where to find it. */
  missing: string[];
  evidence: string[];
  confidence: "high" | "medium" | "low";
  notes: string[];
}

export interface DetectInput {
  html: string;
  url?: string;
  /** Frame and script addresses of the page, as the browser reports them. */
  resources?: string[];
}

export interface DetectResult {
  findings: Finding[];
  truncated: boolean;
}

interface Tag { name: string; attrs: Record<string, string>; form: number }
interface Scan { tags: Tag[]; scripts: string[]; title: string; truncated: boolean }

const MAX_HTML = 3_000_000;

const ENT: Record<string, string> = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", "#39": "'", "#x27": "'", "#34": "\"", "#38": "&" };
const decode = (s: string) => s.replace(/&(amp|quot|apos|lt|gt|#39|#x27|#34|#38);/gi, (_, e: string) => ENT[e.toLowerCase()] ?? _);

const TAG = /<\/form\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Tags with their attributes, the bodies of the page's scripts, and the title. Text content is dropped. */
export function scan(input: string): Scan {
  const truncated = input.length > MAX_HTML;
  let html = truncated ? input.slice(0, MAX_HTML) : input;
  html = html.replace(/<!--[\s\S]*?-->/g, " ");
  const title = decode((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const scripts: string[] = [];
  // Scripts: keep the tag (its src is evidence), take the body out. Only JavaScript bodies are read.
  html = html.replace(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi, (_, open: string, body: string) => {
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(open)?.[1]?.toLowerCase() ?? "";
    if (body.trim() && (!type || /javascript|ecmascript|^module$/.test(type))) scripts.push(body);
    return open;
  });
  // Places where markup is shown or kept, not rendered: their content is not the page's widget.
  html = html.replace(/<(style|pre|code|xmp|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  html = html.replace(/(<textarea\b[^>]*>)[\s\S]*?<\/textarea\s*>/gi, "$1");
  const tags: Tag[] = [];
  let form = -1;
  let forms = 0;
  for (const m of html.matchAll(TAG)) {
    if (!m[1]) { form = -1; continue; }
    const name = m[1].toLowerCase();
    if (name === "form") form = forms++;
    tags.push({ name, attrs: attrsOf(m[2] ?? ""), form });
  }
  return { tags, scripts, title, truncated };
}

interface Res { url: string; host: string; path: string; search: URLSearchParams; from: string }

function parseUrl(raw: string, base: string | undefined, from: string): Res | null {
  const v = (raw || "").trim();
  if (!v || /^(data|blob|javascript|about):/i.test(v)) return null;
  try {
    const u = new URL(v.startsWith("//") ? `https:${v}` : v, base || "https://page.invalid/");
    return { url: u.href, host: u.hostname.toLowerCase(), path: u.pathname, search: u.searchParams, from };
  } catch { return null; }
}

const hasClass = (t: Tag, cls: string) => (t.attrs.class ?? "").split(/\s+/).includes(cls);
const hostIs = (h: string, re: RegExp) => re.test(h);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

// Keys as the providers write them.
const TURNSTILE_KEY = /^(0x[0-9A-Za-z_-]{18,}|[123]x0{8,}[0-9A-Za-z]{2})$/;
const TURNSTILE_KEY_IN = /(0x4[0-9A-Za-z_-]{18,}|[123]x0{8,}[0-9A-Za-z]{2})/;
const RECAPTCHA_KEY = /^6L[0-9A-Za-z_-]{38}$/;
// Keys that always pass or always fail by design: a token for them proves nothing.
const TEST_KEYS = /^([123]x0{8,}[0-9A-Za-z]{2}|6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI|10000000-ffff-ffff-ffff-000000000001)$/;
const CHECK_TITLE = /just a moment|un instant|einen moment|un momento|um momento|attention required|checking your browser|ちょっと待|請稍候|请稍候/i;

// Providers the extension knows by sight; the captcha API has no type for them.
const OTHER_FRAMES: Array<[RegExp, string, string]> = [
  [/(^|\.)(arkoselabs\.com|funcaptcha\.com)$/, "arkose", "Arkose (FunCaptcha)"],
  [/(^|\.)mtcaptcha\.com$/, "mtcaptcha", "MTCaptcha"],
  [/(^|\.)captcha\.(qcloud|qq)\.com$|(^|\.)turing\.captcha\.qcloud\.com$/, "tencent", "Tencent captcha"],
  [/(^|\.)friendlycaptcha\.(com|eu)$/, "friendly_captcha", "Friendly Captcha"],
  [/(^|\.)captchafox\.com$/, "captchafox", "CaptchaFox"],
  [/(^|\.)leminnow\.com$/, "lemin", "Lemin"],
];
const PX_HOSTS = /(^|\.)(px-cdn\.net|px-cloud\.net|perimeterx\.net|pxchk\.net|px-cdn\.com|humansecurity\.com)$/;
const PX_PATH = /\/px\/[A-Za-z0-9]+\/(captcha|init)/i;

function near(script: string, at: number, re: RegExp, span = 600): string | undefined {
  return re.exec(script.slice(at, at + span))?.[1];
}

/** Every captcha the HTML shows, in the order: token widgets, page checks, puzzles, others. */
export function detectCaptchas(input: DetectInput): DetectResult {
  const { tags, scripts, title, truncated } = scan(String(input.html ?? ""));
  const pageUrl = /^https?:\/\//i.test(input.url ?? "") ? String(input.url) : undefined;
  const res: Res[] = [];
  for (const t of tags) {
    if (t.name === "script" && t.attrs.src) { const r = parseUrl(t.attrs.src, pageUrl, "script"); if (r) res.push(r); }
    if (t.name === "iframe" && t.attrs.src) { const r = parseUrl(t.attrs.src, pageUrl, "frame"); if (r) res.push(r); }
  }
  for (const u of input.resources ?? []) { const r = parseUrl(String(u), pageUrl, "resource"); if (r) res.push(r); }
  const code = scripts.join("\n;\n");
  const findings: Finding[] = [];
  const urlMissing = pageUrl ? [] : ["websiteURL: pass url, the address of the page"];
  const base = (): Pick<Finding, "params" | "page" | "missing" | "evidence" | "notes"> =>
    ({ params: pageUrl ? { websiteURL: pageUrl } : {}, page: {}, missing: [...urlMissing], evidence: [], notes: [] });

  // ── Cloudflare's full-page check ─────────────────────────────────────
  // The page itself is the check: Cloudflare's own options object, or its title with the challenge script.
  // /cdn-cgi/challenge-platform/scripts/jsd/ alone is on ordinary pages (a background check with nothing to solve).
  const cfOpt = /\b_cf_chl_opt\b/.test(code);
  const cfOrchestrate = res.some((r) => /\/cdn-cgi\/challenge-platform\/.*\/orchestrate\/(chl_page|managed|jsch)\//.test(r.path));
  const cfForm = tags.some((t) => t.attrs.id === "challenge-form" || t.attrs.id === "challenge-error-text" || t.attrs.id === "cf-challenge-running");
  const cfPage = cfOpt || cfOrchestrate || (CHECK_TITLE.test(title) && cfForm);
  if (cfPage) {
    const f: Finding = { kind: "cloudflare", name: "Cloudflare check page", ...base(), confidence: cfOpt || cfOrchestrate ? "high" : "medium" };
    if (cfOpt) f.evidence.push("script: window._cf_chl_opt");
    if (cfOrchestrate) f.evidence.push("script: /cdn-cgi/challenge-platform/.../orchestrate/");
    if (CHECK_TITLE.test(title)) f.evidence.push(`title: ${title.slice(0, 60)}`);
    f.missing.push("proxy: your proxy URL (the cookie only works from the address that passed the check)");
    f.notes.push("The answer is a cookie, not a token: set it, send the same user agent, and request the page again.");
    findings.push(f);
  }

  // ── Turnstile ────────────────────────────────────────────────────────
  {
    const widgets = tags.filter((t) => hasClass(t, "cf-turnstile"));
    const frames = res.filter((r) => r.host === "challenges.cloudflare.com" && /\/turnstile\//.test(r.path) && !/\/api\.js$/.test(r.path));
    const api = res.some((r) => r.host === "challenges.cloudflare.com" && /\/turnstile\/v0\/api\.js$/.test(r.path));
    const field = tags.some((t) => t.attrs.name === "cf-turnstile-response");
    const byKey = new Map<string, Finding>();
    const get = (key: string): Finding => {
      let f = byKey.get(key);
      if (!f) { f = { kind: "turnstile", name: "Cloudflare Turnstile", ...base(), confidence: "high" }; f.params.websiteKey = key; byKey.set(key, f); }
      return f;
    };
    for (const r of frames) {
      const key = TURNSTILE_KEY_IN.exec(r.path)?.[1];
      if (key) get(key).evidence.push(`${r.from}: challenges.cloudflare.com widget frame with the key`);
    }
    for (const w of widgets) {
      const key = (w.attrs["data-sitekey"] ?? "").trim();
      if (!TURNSTILE_KEY.test(key)) continue;
      const f = get(key);
      f.evidence.push(`<${w.name} class="cf-turnstile" data-sitekey>`);
      const meta: Record<string, string> = {};
      if (w.attrs["data-action"]) meta.action = w.attrs["data-action"];
      if (w.attrs["data-cdata"]) meta.cdata = w.attrs["data-cdata"];
      if (Object.keys(meta).length) f.params.metadata = meta;
      if (w.attrs["data-callback"]) f.page.callback = w.attrs["data-callback"];
      if (w.attrs["data-response-field-name"]) f.page.responseField = w.attrs["data-response-field-name"];
    }
    for (const m of code.matchAll(/\bturnstile\s*\.\s*render\s*\(/g)) {
      const key = near(code, m.index, /sitekey["']?\s*:\s*["']([^"']+)["']/);
      if (!key || !TURNSTILE_KEY.test(key)) continue;
      const f = get(key);
      f.evidence.push("script: turnstile.render({sitekey})");
      const action = near(code, m.index, /\baction["']?\s*:\s*["']([^"']+)["']/);
      const cdata = near(code, m.index, /\bcData["']?\s*:\s*["']([^"']+)["']/);
      if (action || cdata) f.params.metadata = { ...(f.params.metadata as object ?? {}), ...(action ? { action } : {}), ...(cdata ? { cdata } : {}) };
      const cb = near(code, m.index, /\bcallback["']?\s*:\s*([A-Za-z_$][\w$.]*)\s*[,}]/);
      if (cb && !f.page.callback && !/^function$/.test(cb)) f.page.callback = cb;
    }
    for (const f of byKey.values()) findings.push(f);
    // The script or the answer field without a key: a widget is (or will be) there, its key is not in the HTML.
    if (!byKey.size && !cfPage && (api || field || widgets.length)) {
      const f: Finding = { kind: "turnstile", name: "Cloudflare Turnstile", ...base(), confidence: widgets.length || field ? "medium" : "low" };
      if (api) f.evidence.push("script: challenges.cloudflare.com/turnstile/v0/api.js");
      if (field) f.evidence.push("input name=cf-turnstile-response");
      if (widgets.length) f.evidence.push("class cf-turnstile without data-sitekey");
      f.missing.push("websiteKey: not in the HTML; pass resources (the page's frame URLs): the challenges.cloudflare.com frame address holds the key (0x...)");
      findings.push(f);
    }
  }

  // ── reCAPTCHA v2 / v3, plain and Enterprise ──────────────────────────
  {
    const G = /^(www\.)?(google\.com|recaptcha\.net)$/;
    const apis = res.filter((r) => hostIs(r.host, G) && /\/recaptcha\/(api|enterprise)\.js$/.test(r.path));
    const anchors = res.filter((r) => hostIs(r.host, G) && /\/recaptcha\/(api2|enterprise)\/anchor$/.test(r.path));
    const widgets = tags.filter((t) => hasClass(t, "g-recaptcha"));
    const field = tags.some((t) => t.attrs.name === "g-recaptcha-response");
    const enterprise = apis.some((r) => /enterprise\.js$/.test(r.path)) || anchors.some((r) => /\/enterprise\//.test(r.path))
      || /\bgrecaptcha\s*\.\s*enterprise\b/.test(code);
    const net = [...apis, ...anchors].some((r) => /recaptcha\.net$/.test(r.host));
    interface K { v3: boolean; invisible: boolean; action?: string; callback?: string; evidence: string[]; sure: boolean }
    const keys = new Map<string, K>();
    const get = (key: string): K => {
      let k = keys.get(key);
      if (!k) { k = { v3: false, invisible: false, evidence: [], sure: false }; keys.set(key, k); }
      return k;
    };
    for (const r of anchors) {
      const key = r.search.get("k") ?? "";
      if (!RECAPTCHA_KEY.test(key)) continue;
      const k = get(key);
      k.sure = true;
      if (r.search.get("size") === "invisible") k.invisible = true;
      k.evidence.push(`${r.from}: recaptcha anchor frame, k=`);
    }
    for (const r of apis) {
      const render = r.search.get("render") ?? "";
      if (!RECAPTCHA_KEY.test(render)) continue;
      const k = get(render);
      k.v3 = true; k.sure = true;
      k.evidence.push(`script: recaptcha/${/enterprise/.test(r.path) ? "enterprise" : "api"}.js?render=<key>`);
    }
    for (const w of widgets) {
      const key = (w.attrs["data-sitekey"] ?? "").trim();
      if (!RECAPTCHA_KEY.test(key)) continue;
      const k = get(key);
      k.evidence.push(`<${w.name} class="g-recaptcha" data-sitekey>`);
      if ((w.attrs["data-size"] ?? "").toLowerCase() === "invisible") k.invisible = true;
      if (w.attrs["data-callback"]) k.callback = w.attrs["data-callback"];
      if (w.attrs["data-action"]) { k.v3 = true; k.action = w.attrs["data-action"]; }
    }
    for (const m of code.matchAll(/\bgrecaptcha\s*(?:\.\s*enterprise\s*)?\.\s*execute\s*\(\s*["']([^"']+)["']/g)) {
      if (!RECAPTCHA_KEY.test(m[1])) continue;
      const k = get(m[1]);
      k.v3 = true;
      k.action ??= near(code, m.index, /\baction["']?\s*:\s*["']([^"']+)["']/, 300);
      k.evidence.push("script: grecaptcha.execute(key, {action})");
    }
    for (const m of code.matchAll(/\bgrecaptcha\s*(?:\.\s*enterprise\s*)?\.\s*render\s*\(/g)) {
      const key = near(code, m.index, /sitekey["']?\s*:\s*["']([^"']+)["']/);
      if (!key || !RECAPTCHA_KEY.test(key)) continue;
      const k = get(key);
      if (near(code, m.index, /\bsize["']?\s*:\s*["'](invisible)["']/)) k.invisible = true;
      const cb = near(code, m.index, /\bcallback["']?\s*:\s*([A-Za-z_$][\w$.]*)\s*[,}]/);
      if (cb && !k.callback && cb !== "function") k.callback = cb;
      k.evidence.push("script: grecaptcha.render({sitekey})");
    }
    for (const [key, k] of keys) {
      const fam = `recaptcha_${k.v3 ? "v3" : "v2"}${enterprise ? "_enterprise" : ""}`;
      const f: Finding = { kind: fam, name: `reCAPTCHA ${k.v3 ? "v3" : "v2"}${enterprise ? " Enterprise" : ""}`, ...base(), confidence: "high" };
      f.params.websiteKey = key;
      if (k.v3) { if (k.action) f.params.pageAction = k.action; } else if (k.invisible) f.params.isInvisible = true;
      if (net) f.params.apiDomain = "recaptcha.net";
      if (k.callback) f.page.callback = k.callback;
      f.evidence.push(...uniq(k.evidence));
      if (k.v3 && !k.action) f.notes.push("pageAction was not found in the HTML: read it from the page's grecaptcha.execute call, the site may check it.");
      if (!k.v3 && !k.sure && widgets.some((w) => w.attrs["data-sitekey"] === key && w.name === "button")) {
        f.notes.push("A key bound to a button can be v2 invisible or v3: if the token is refused, solve again as the other version.");
      }
      findings.push(f);
    }
    if (!keys.size && (apis.length || widgets.length || field)) {
      const v3ish = apis.some((r) => { const x = r.search.get("render"); return !!x && x !== "explicit" && x !== "onload"; });
      const f: Finding = { kind: `recaptcha_${v3ish ? "v3" : "v2"}${enterprise ? "_enterprise" : ""}`,
        name: `reCAPTCHA${enterprise ? " Enterprise" : ""}`, ...base(), confidence: widgets.length || field ? "medium" : "low" };
      if (apis.length) f.evidence.push("script: recaptcha api.js");
      if (widgets.length) f.evidence.push("class g-recaptcha without data-sitekey");
      if (field) f.evidence.push("textarea name=g-recaptcha-response");
      f.missing.push("websiteKey: not in the HTML; pass resources (the page's frame URLs): the recaptcha anchor frame has it as k=");
      f.notes.push("The version (v2 or v3) could not be told without the key's frame or script.");
      findings.push(f);
    }
  }

  // ── Puzzles answered from pictures (solve_captcha_task) ──────────────
  {
    const gt = res.filter((r) => /(^|\.)(geetest|geevisit)\.com$/.test(r.host));
    const init3 = /\binitGeetest\s*\(/.test(code);
    const init4 = /\binitGeetest4\s*\(/.test(code);
    if (gt.length || init3 || init4) {
      const v4 = init4 || gt.some((r) => /^gcaptcha4\./.test(r.host) || /\/v4\/|gt4\.js/.test(r.path));
      const f: Finding = { kind: "geetest_slide", name: `GeeTest v${v4 ? 4 : 3}`, ...base(), confidence: "high" };
      f.missing = [];
      f.params = { version: v4 ? 4 : 3 };
      if (gt.length) f.evidence.push(`${gt[0].from}: ${gt[0].host}`);
      if (init3 || init4) f.evidence.push(`script: ${init4 ? "initGeetest4" : "initGeetest"}()`);
      f.missing.push(v4
        ? "imageBackground, imageSlice, top, bgCssWidth: the puzzle's two pictures and the piece's position, from the open widget"
        : "imageBackground, imageFull: GeeTest's two pictures as served, from the open widget");
      f.notes.push("Only the slide puzzle is answered, and only as a distance to drag: the drag is yours to make.");
      findings.push(f);
    }
    const waf = res.filter((r) => /(^|\.)awswaf\.com$/.test(r.host));
    const wafCaptcha = waf.some((r) => /captcha\.js$/.test(r.path)) || tags.some((t) => t.name === "awswaf-captcha")
      || /\bAwsWafCaptcha\s*\.\s*renderCaptcha\s*\(/.test(code)
      || (waf.length > 0 && tags.some((t) => /\bamzn-captcha-/.test(t.attrs.class ?? "")));
    if (wafCaptcha) {
      const f: Finding = { kind: "aws_waf", name: "AWS WAF captcha", ...base(), confidence: "high" };
      f.missing = [];
      f.params = {};
      f.evidence.push(waf.length ? `${waf[0].from}: ${waf[0].host}` : "awswaf-captcha element");
      f.missing.push("images, question: the grid picture and \"aws:grid:<object>\" from the open puzzle");
      f.notes.push("The answer is the tiles to click: the clicks are yours to make.");
      findings.push(f);
    }
    const dd = res.filter((r) => /(^|\.)captcha-delivery\.com$/.test(r.host) && /\/captcha\//.test(r.path));
    if (dd.length) {
      const f: Finding = { kind: "slider", name: "DataDome slider", ...base(), confidence: "high" };
      f.missing = ["imageBackground: the puzzle picture with the gap, from the frame"];
      f.params = { module: "slider_1" };
      f.evidence.push(`${dd[0].from}: ${dd[0].host}/captcha/`);
      findings.push(f);
    }
  }

  // ── Image text ───────────────────────────────────────────────────────
  // The extension's strict rule: a picture whose own attributes say captcha plus an answer field, or a field
  // that says captcha plus an inline picture. Here the answer field must also name captcha or share the form.
  {
    const hints = (t: Tag, keys: string[]) => keys.map((k) => t.attrs[k] ?? "").join(" ").toLowerCase();
    const inputs = tags.filter((t) => t.name === "input" && ["text", ""].includes((t.attrs.type ?? "text").toLowerCase()));
    const capInputs = inputs.filter((t) => hints(t, ["placeholder", "name", "id", "aria-label", "class"]).includes("captcha")
      && !/g-recaptcha|h-captcha|cf-turnstile/.test(hints(t, ["name", "id", "class"])));
    const imgs = tags.filter((t) => t.name === "img");
    // what the picture says about itself; a data: URL's bytes say nothing
    const about = (t: Tag) => `${hints(t, ["alt", "id", "class", "title", "name"])} ${/^data:/i.test(t.attrs.src ?? "") ? "" : (t.attrs.src ?? "").toLowerCase()}`;
    const strong = imgs.find((t) => about(t).includes("captcha")
      && !(t.attrs.src ?? "").toLowerCase().split("?")[0].endsWith(".svg")
      && !/recaptcha|hcaptcha|logo|badge|icon/.test(about(t)));
    const inline = imgs.find((t) => /^(data:image\/(?!svg)|blob:)/i.test(t.attrs.src ?? ""));
    let img: Tag | undefined;
    let confidence: Finding["confidence"] = "high";
    if (strong && capInputs.length) img = strong;
    else if (strong) {
      const answer = inputs.find((t) => t.form >= 0 && t.form === strong.form
        && /captcha|answer|code|characters|text/.test(hints(t, ["placeholder", "name", "id", "aria-label"])));
      if (answer) { img = strong; confidence = "medium"; }
    } else if (capInputs.length && inline) img = inline;
    if (img) {
      const f: Finding = { kind: "image_text", name: "Image text captcha", ...base(), confidence };
      f.missing = [];
      const src = img.attrs.src ?? "";
      f.evidence.push(`<img ${img.attrs.id ? `id="${img.attrs.id}" ` : ""}src="${src.slice(0, 80)}${src.length > 80 ? "..." : ""}"> with an answer field`);
      f.missing.push(/^data:image\//i.test(src)
        ? "body: the picture; its src is a data: URL, pass that as body"
        : "body: the picture as base64 (take it from the element in your browser, e.g. a screenshot of the <img>)");
      f.notes.push("The answer is text to type into the page's field.");
      findings.push(f);
    }
  }

  // ── Known providers with no type in the captcha API ──────────────────
  {
    const add = (kind: string, name: string, evidence: string, extra?: (f: Finding) => void) => {
      let f = findings.find((x) => x.kind === kind);
      if (!f) { f = { kind, name, params: {}, page: {}, missing: [], evidence: [], confidence: "high", notes: [] }; findings.push(f); }
      f.evidence.push(evidence);
      extra?.(f);
    };
    const hc = tags.filter((t) => hasClass(t, "h-captcha") && t.attrs["data-sitekey"]);
    const hcRes = res.filter((r) => /(^|\.)hcaptcha\.com$/.test(r.host));
    for (const w of hc) add("hcaptcha", "hCaptcha", `<${w.name} class="h-captcha" data-sitekey>`, (f) => { f.params.websiteKey = w.attrs["data-sitekey"]; });
    if (hcRes.length) add("hcaptcha", "hCaptcha", `${hcRes[0].from}: ${hcRes[0].host}`);
    for (const [re, kind, name] of OTHER_FRAMES) {
      const r = res.find((x) => re.test(x.host));
      if (r) add(kind, name, `${r.from}: ${r.host}`);
    }
    const sel: Array<[(t: Tag) => boolean, string, string, string]> = [
      [(t) => t.attrs.id === "FunCaptcha" || /^arkose/i.test(t.attrs.id ?? "") || "data-pkey" in t.attrs, "arkose", "Arkose (FunCaptcha)", "Arkose element"],
      [(t) => hasClass(t, "frc-captcha"), "friendly_captcha", "Friendly Captcha", "class frc-captcha"],
      [(t) => hasClass(t, "mtcaptcha"), "mtcaptcha", "MTCaptcha", "class mtcaptcha"],
      [(t) => t.attrs.id === "div_for_keycaptcha", "keycaptcha", "KeyCaptcha", "id div_for_keycaptcha"],
      [(t) => t.attrs.id === "lemin-cropped-captcha", "lemin", "Lemin", "id lemin-cropped-captcha"],
      [(t) => hasClass(t, "captchafox"), "captchafox", "CaptchaFox", "class captchafox"],
      [(t) => t.name === "altcha-widget", "altcha", "ALTCHA", "<altcha-widget>"],
    ];
    for (const [test, kind, name, ev] of sel) if (tags.some(test)) add(kind, name, ev);
    const px = tags.some((t) => t.attrs.id === "px-captcha");
    const pxRes = res.some((r) => PX_HOSTS.test(r.host) || PX_PATH.test(r.path));
    if (px) {
      add("press_and_hold", "HUMAN press and hold", "id px-captcha", (f) => {
        if (!pxRes) f.confidence = "medium";
        f.notes.push("Passed by pressing and holding the button with real pointer input: there is nothing to solve remotely.");
      });
    }
    const altcha = findings.find((f) => f.kind === "altcha");
    if (altcha) altcha.notes.push("A proof of work the page's own script does when its checkbox is clicked: click it and wait for \"verified\".");
  }

  for (const f of findings) {
    f.evidence = uniq(f.evidence).slice(0, 4);
    const key = String(f.params.websiteKey ?? "");
    if (key && TEST_KEYS.test(key)) f.notes.push("This is the provider's public test key: it passes (or fails) for everyone by design, so solving it proves nothing.");
  }
  return { findings, truncated };
}
