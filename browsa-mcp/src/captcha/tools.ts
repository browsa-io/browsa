// The captcha_page group: captcha solving for a browser that is not Browsa's.
//
//   detect_captcha          HTML in, the captchas found out. Local: no request.
//   solve_captcha_on_page   one token task through the captcha API, and an
//                           "apply" block to run in the caller's browser.
//   captcha_allowance       this session's local limits and spend.
//
// Answers are compact JSON.

import { BrowsaError } from "browsa";
import { buildApply } from "./apply.js";
import { type Catalogue, catalogue, type CatType, refreshCatalogue, typeInfo } from "./catalogue.js";
import { runCaptchaTask } from "./client.js";
import { detectCaptchas, type Finding } from "./detect.js";
import { guard, type Refusal } from "./guards.js";

export const captchaPageTools = [
  {
    name: "detect_captcha",
    description:
      "Find the captchas in a page's HTML, for a browser of your own. Runs locally: sends nothing, needs no key, free. " +
      "Returns each one's task type, site key and parameters, whether Browsa's captcha API takes it (status), and what is missing.",
    inputSchema: {
      type: "object",
      required: ["html"],
      properties: {
        html: { type: "string", description: "The page's HTML, e.g. document.documentElement.outerHTML." },
        url: { type: "string", description: "The page's address." },
        resources: { type: "array", items: { type: "string" }, description: "The page's frame and script URLs; site keys are often only there." },
      },
    },
  },
  {
    name: "solve_captcha_on_page",
    description:
      "Solve a token captcha that is on a page in your own browser (the catalogue's token types, e.g. Turnstile, reCAPTCHA v2 and v3) through Browsa's captcha API. " +
      "Returns the solution, its cost, and apply: a JavaScript expression to evaluate in that page (sets the token, calls the page's callback), or cookies to set and re-request with. " +
      "It does not touch your browser and cannot click. Picture puzzles: send the image to solve_captcha_task. Charged only when solved.",
    inputSchema: {
      type: "object",
      properties: {
        captcha: { type: "object", description: "One entry of detect_captcha's captchas, or {type, params: {websiteURL, websiteKey, ...}}." },
        html: { type: "string", description: "Instead of captcha: the page's HTML; detection runs first." },
        url: { type: "string", description: "With html: the page's address." },
        resources: { type: "array", items: { type: "string" }, description: "With html: frame and script URLs." },
        proxy: { type: "string", description: "Your proxy, http://user:pass@host:port, for types that need one (detect_captcha lists it under missing)." },
        timeout_seconds: { type: "number", description: "Default 180, at most 600." },
      },
    },
  },
  {
    name: "captcha_allowance",
    description: "This server's local captcha limits: credits spent and left under the session cap, rate and concurrency. Free, no request.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export const CAPTCHA_PAGE_TOOLS = captchaPageTools.map((t) => t.name) as string[];

// Which task type answers each family the detector names. The first one the catalogue lists is used.
const FAMILY_TYPES: Record<string, string[]> = {
  turnstile: ["AntiTurnstileTaskProxyLess"],
  recaptcha_v2: ["ReCaptchaV2TaskProxyLess"],
  recaptcha_v2_enterprise: ["ReCaptchaV2EnterpriseTaskProxyLess"],
  recaptcha_v3: ["ReCaptchaV3TaskProxyLess"],
  recaptcha_v3_enterprise: ["ReCaptchaV3EnterpriseTaskProxyLess"],
  cloudflare: ["AntiCloudflareTask"],
  geetest_slide: ["GeeTestSlide"],
  aws_waf: ["AwsWafClassification"],
  slider: ["VisionEngine"],
  image_text: ["ImageToTextTask"],
  altcha: ["AltchaTask"],
};

export interface Detected {
  kind: string;
  name: string;
  type: string | null;
  status: string;                       // live | off | not_in_catalogue
  solve_with: "solve_captcha_on_page" | "solve_captcha_task" | null;
  ready: boolean;
  params: Record<string, unknown>;
  page?: Finding["page"];
  missing: string[];
  credits_per_solve?: number | null;
  confidence: string;
  evidence: string[];
  notes?: string[];
}

/** A finding with what the catalogue says about its type. */
export function annotate(f: Finding, cat: Catalogue): Detected {
  const info = (FAMILY_TYPES[f.kind] ?? []).map((n) => typeInfo(n, cat)).find(Boolean);
  const notes = [...f.notes];
  if (!info) {
    return {
      kind: f.kind, name: f.name, type: null, status: "not_in_catalogue", solve_with: null, ready: false,
      params: f.params, missing: [], confidence: f.confidence, evidence: f.evidence,
      notes: [...notes, "The captcha API has no task type for this captcha."],
    };
  }
  if (info.status !== "live") notes.push(`This type is switched off in the catalogue${info.offReason ? `: ${info.offReason}` : ""}.`);
  const token = info.kind === "token";
  const out: Detected = {
    kind: f.kind, name: f.name, type: info.type, status: info.status,
    solve_with: token ? "solve_captcha_on_page" : "solve_captcha_task",
    ready: token && info.status === "live" && f.missing.every((m) => m.startsWith("proxy:")),
    params: f.params, missing: f.missing, credits_per_solve: info.credits,
    confidence: f.confidence, evidence: f.evidence,
  };
  if (Object.keys(f.page).length) out.page = f.page;
  if (notes.length) out.notes = notes;
  return out;
}

export function detect(args: Record<string, any>): { captchas: Detected[]; truncated: boolean; cat: Catalogue } {
  const cat = catalogue();
  const { findings, truncated } = detectCaptchas({
    html: String(args.html ?? ""), url: typeof args.url === "string" ? args.url : undefined,
    resources: Array.isArray(args.resources) ? args.resources.map(String) : undefined,
  });
  return { captchas: findings.map((f) => annotate(f, cat)), truncated, cat };
}

type Answer = { text: string; isError?: boolean };
const answer = (o: unknown): Answer => ({ text: JSON.stringify(o) });
const refuse = (message: string, extra: Record<string, unknown> = {}): Answer => ({ isError: true, text: JSON.stringify({ error: message, ...extra }) });

function detectTool(args: Record<string, any>): Answer {
  if (typeof args.html !== "string" || !args.html.trim()) return refuse("html is required: the page's HTML as text");
  const { captchas, truncated, cat } = detect(args);
  return answer({
    found: captchas.length,
    captchas,
    ...(captchas.length ? {} : { note: "No captcha in this HTML. A widget inside a frame is only seen through its frame URL: pass resources." }),
    ...(truncated ? { truncated: "only the first 3,000,000 characters were read" } : {}),
    catalogue: { source: cat.source, as_of: cat.asOf },
  });
}

function limitRefusal(r: Refusal): Answer {
  return refuse(`refused by this server's local limit (${r.limit}): ${r.message}`, {
    code: "LOCAL_LIMIT", limit: r.limit, retry_after_seconds: r.retry_after_seconds, retry: r.retry,
    charged: false, allowance: guard.allowance(),
  });
}

/** Runs one solve under the local limits. `price` is reserved against the spend cap until the solve ends. */
export async function guardedSolve<T>(price: number, run: () => Promise<{ credits: number; value: T }>): Promise<{ refused: Answer } | { value: T }> {
  const g = guard.begin(price);
  if (!g.ok) return { refused: limitRefusal(g.refusal) };
  let credits = 0;
  try {
    const r = await run();
    credits = r.credits;
    return { value: r.value };
  } finally {
    g.ticket.done(credits);
  }
}

/** The price to hold for a type: the catalogue's, or the dearest listed when the type is unknown. */
export function priceOf(type: string): number {
  const cat = catalogue();
  return typeInfo(type, cat)?.credits ?? Math.max(0, ...cat.types.map((t) => t.credits ?? 0));
}

/** What a solved answer cost in credits: the API's figure, or the catalogue price when it gave none. */
export function chargedCredits(body: any, type: string): number {
  const c = body?.cost;
  if (c && c.charged === false) return 0;
  if (c && typeof c.credits === "number") return c.credits;
  if (c && c.unit === "credits" && typeof c.amount === "number") return c.amount;
  return priceOf(type);
}

let reportToolListed = false;
/** server.ts says whether report_captcha_result is listed, so answers only name tools the client has. */
export function setReportToolListed(v: boolean) { reportToolListed = v; }

async function solveOnPage(args: Record<string, any>): Promise<Answer> {
  await refreshCatalogue();
  const cat = catalogue();
  let picked: { type: string | null; params: Record<string, any>; page?: Finding["page"]; missing?: string[] } | null = null;
  if (args.captcha && typeof args.captcha === "object") {
    const c = args.captcha;
    picked = { type: typeof c.type === "string" ? c.type : null, params: { ...(c.params ?? {}) }, page: c.page, missing: [] };
    // {type, websiteURL, websiteKey} given flat is taken too
    for (const k of ["websiteURL", "websiteKey", "pageAction", "isInvisible", "metadata", "apiDomain", "userAgent"]) {
      if (c[k] !== undefined && picked.params[k] === undefined) picked.params[k] = c[k];
    }
    if (!picked.type && typeof c.kind === "string") picked.type = (FAMILY_TYPES[c.kind] ?? []).find((n) => typeInfo(n, cat)) ?? null;
  } else if (typeof args.html === "string" && args.html.trim()) {
    const { captchas } = detect(args);
    const tokens = captchas.filter((c) => c.solve_with === "solve_captcha_on_page" && c.status === "live");
    if (tokens.length !== 1) {
      return refuse(tokens.length
        ? "more than one token captcha is in this HTML: pass the one to solve as captcha"
        : captchas.length ? "no captcha in this HTML can be solved by this tool" : "no captcha was found in this HTML",
      { code: tokens.length ? "SEVERAL_CAPTCHAS" : captchas.length ? "NOT_SOLVABLE_HERE" : "NO_CAPTCHA", charged: false, captchas });
    }
    picked = { type: tokens[0].type, params: { ...tokens[0].params }, page: tokens[0].page, missing: tokens[0].missing };
  } else {
    return refuse("pass captcha (an entry from detect_captcha) or html with url", { charged: false });
  }
  if (!picked.type) return refuse("the captcha API has no task type for this captcha", { code: "NOT_IN_CATALOGUE", charged: false });

  // With the caller's proxy the task is the type's proxy form, when the catalogue has one.
  let type = picked.type;
  const proxy = typeof args.proxy === "string" && args.proxy.trim() ? args.proxy.trim() : picked.params.proxy;
  if (proxy && /ProxyLess$/i.test(type) && typeInfo(type.replace(/ProxyLess$/i, ""), cat)) type = type.replace(/ProxyLess$/i, "");
  const info: CatType | undefined = typeInfo(type, cat);
  if (!info) {
    return refuse(`${type} is not a type in the catalogue (names are case-sensitive)`,
      { code: "NOT_IN_CATALOGUE", charged: false, token_types: cat.types.filter((t) => t.kind === "token" && t.status === "live").map((t) => t.type) });
  }
  if (info.kind !== "token") {
    return refuse(`${type} is answered from a picture, not from the page's address: send the image with solve_captcha_task`,
      { code: "NOT_A_TOKEN_TYPE", charged: false, required: [...info.required, ...info.oneOf.map((g) => g.join(" or "))] });
  }
  if (info.status !== "live") {
    return refuse(`${type} is switched off in the catalogue${info.offReason ? `: ${info.offReason}` : ""}`, { code: "TYPE_OFF", charged: false });
  }
  const task: Record<string, any> = { ...picked.params, type };
  if (proxy) task.proxy = proxy;
  const missing = info.required.filter((p) => task[p] === undefined || task[p] === "");
  if (missing.length) {
    return refuse(`${type} needs ${missing.join(", ")}`, {
      code: "MISSING_PARAMETER", charged: false, missing,
      ...(picked.missing?.length ? { where: picked.missing } : {}),
    });
  }

  const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 180, 5), 600) * 1000;
  const r = await guardedSolve(priceOf(type), async () => {
    const o = await runCaptchaTask(task, timeoutMs);
    return { credits: o.state === "solved" ? chargedCredits(o.body, type) : 0, value: o };
  });
  if ("refused" in r) return r.refused;
  const o = r.value;
  if (o.state === "error") {
    const b = o.body;
    return refuse(b.errorDescription || b.errorCode, {
      code: b.errorCode, ...(b.taskId ? { task_id: b.taskId } : {}), charged: b.charged === true, ...(b.fix ? { fix: b.fix } : {}),
      allowance: guard.allowance(),
    });
  }
  if (o.state === "timeout") {
    return refuse(`no solution after ${Math.round(o.timeoutMs / 1000)}s; the task may still finish (charged only if solved)`,
      { code: "TIMEOUT", task_id: o.taskId, allowance: guard.allowance() });
  }
  const apply = buildApply(type, o.body.solution, String(task.websiteURL ?? ""), picked.page ?? {});
  return answer({
    task_id: o.taskId, type, solution: o.body.solution, seconds: o.seconds,
    cost: o.body.cost ?? { charged: true, credits: chargedCredits(o.body, type), note: "The catalogue's price: the API's answer carried no cost." },
    apply,
    allowance: guard.allowance(),
    next: `do apply.steps in your browser, then check the page's own answer${reportToolListed ? "; then report_captcha_result" : ""}`,
  });
}

export async function callCaptchaPage(name: string, args: Record<string, any>): Promise<Answer> {
  try {
    switch (name) {
      case "detect_captcha": return detectTool(args);
      case "solve_captcha_on_page": return await solveOnPage(args);
      case "captcha_allowance":
        return answer({ ...guard.allowance(), ...(guard.configured ? {} : { note: "No local limit is set (BROWSA_CAPTCHA_MAX_CREDITS, BROWSA_CAPTCHA_RATE_PER_MINUTE, BROWSA_CAPTCHA_CONCURRENCY). The workspace's own limits still apply." }) });
      default: return refuse(`unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof BrowsaError) return refuse(e.message, { code: e.code, status: e.status });
    const msg = (e as Error).message || String(e);
    if ((e as Error)?.name === "TimeoutError" || /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
      return refuse(`could not reach the captcha API (${msg}); try again when the network is back`, { code: "NETWORK", allowance: guard.allowance() });
    }
    return refuse(msg);
  }
}
