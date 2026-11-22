/**
 * Browsa's captcha-solving API: createTask, getTaskResult, getBalance, reports and callbacks, in the
 * format CapSolver, Anti-Captcha, CapMonster and 2Captcha's v2 API share.
 * Same key and credits as the browser API.
 *
 *     import { CaptchaClient, captchaTasks as tasks } from "browsa";
 *
 *     const cap = new CaptchaClient();          // BROWSA_API_KEY
 *     const sol = await cap.solve(tasks.recaptchaV3("https://example.com/login", "6Lc...", { pageAction: "login" }));
 *     sol.gRecaptchaResponse;
 *
 * Every answer is HTTP 200 with errorId 0 (ok) or 1 (error, with errorCode).
 * Recognition tasks are answered in createTask; token tasks return a taskId to poll.
 * Measured pass rates per type: https://browsa.io/captcha
 */
import { BrowsaError, TimeoutError } from "./errors";
import { VERSION } from "./version";

export const DEFAULT_CAPTCHA_URL = "https://captcha.browsa.io";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_SOLVE_TIMEOUT = 180_000;
const DEFAULT_POLL_MS = 3_000;
const DEFAULT_WAIT_SECONDS = 20; // how long the API is asked to hold one call (it allows up to 25)
const USER_AGENT = `browsa-ts/${VERSION} (captcha)`;

// ── Errors ───────────────────────────────────────────────────────────────

/** The API answered errorId 1. `code` is its errorCode (ERROR_CAPTCHA_UNSOLVABLE,
 * ERROR_ZERO_BALANCE, ...); `fix` says what to change and `charged` whether the request
 * cost anything. Failed and unsolvable tasks are not charged. */
export class CaptchaError extends BrowsaError {
  taskId?: string;
  fix?: string;
  charged: boolean;
  constructor(message: string, opts: { code?: string; taskId?: string; status?: number; body?: unknown } = {}) {
    super(message, opts);
    this.name = "CaptchaError";
    this.taskId = opts.taskId;
    const b = (opts.body && typeof opts.body === "object" ? opts.body : {}) as Record<string, unknown>;
    this.fix = typeof b.fix === "string" ? b.fix : undefined;
    this.charged = b.charged === true;
  }
}

/** Local: solve() gave up waiting. The task may still finish; it is charged only if solved. */
export class CaptchaTimeoutError extends CaptchaError {
  constructor(message: string, opts: { taskId?: string } = {}) {
    super(message, { code: "TIMEOUT", ...opts });
    this.name = "CaptchaTimeoutError";
  }
}

// ── Types ────────────────────────────────────────────────────────────────

export type RecognitionTaskType = "ImageToTextTask" | "ReCaptchaV2Classification" | "AwsWafClassification" | "VisionEngine" | "GeeTestSlide"
  | "RotateTask" | "ClickOrderTask" | "AltchaTask"
  | "TextCaptchaTask" | "BoundingBoxTask" | "DrawAroundTask" | "DragDropTask"
  // GET /types says which types are live now (31 of 34 on 2026-11-22, hCaptcha and the audio challenge among them)
  | "GeeTestGridTask" | "GeeTestIconTask" | "GeeTestNineTask" | "GeeTestShapeTask" | "SliderGapTask"
  | "TileSwapTask" | "JigsawTask" | "MtCaptchaTask" | "CyberSiaraTask" | "AudioTask" | "HCaptchaTask";
export type TokenTaskType =
  | "ReCaptchaV2TaskProxyLess" | "ReCaptchaV2Task"
  | "ReCaptchaV2EnterpriseTaskProxyLess" | "ReCaptchaV2EnterpriseTask"
  | "ReCaptchaV3TaskProxyLess" | "ReCaptchaV3Task"
  | "ReCaptchaV3EnterpriseTaskProxyLess" | "ReCaptchaV3EnterpriseTask"
  | "AntiTurnstileTaskProxyLess" | "AntiTurnstileTask"
  | "AntiCloudflareTask";
export type CaptchaTaskType = RecognitionTaskType | TokenTaskType;

/** The live list, with parameters, prices and measured numbers: `CaptchaClient.listTypes()`. */
export const CAPTCHA_TASK_TYPES: CaptchaTaskType[] = [
  "ImageToTextTask", "ReCaptchaV2Classification", "AwsWafClassification", "VisionEngine", "GeeTestSlide",
  "RotateTask", "ClickOrderTask", "AltchaTask",
  "TextCaptchaTask", "BoundingBoxTask", "DrawAroundTask", "DragDropTask",
  "GeeTestGridTask", "GeeTestIconTask", "GeeTestNineTask", "GeeTestShapeTask", "SliderGapTask",
  "TileSwapTask", "JigsawTask", "MtCaptchaTask", "CyberSiaraTask", "AudioTask", "HCaptchaTask",
  "ReCaptchaV2TaskProxyLess", "ReCaptchaV2Task", "ReCaptchaV2EnterpriseTaskProxyLess", "ReCaptchaV2EnterpriseTask",
  "ReCaptchaV3TaskProxyLess", "ReCaptchaV3Task", "ReCaptchaV3EnterpriseTaskProxyLess", "ReCaptchaV3EnterpriseTask",
  "AntiTurnstileTaskProxyLess", "AntiTurnstileTask", "AntiCloudflareTask",
];

export interface TokenSolution { gRecaptchaResponse: string; userAgent?: string; createTime?: number }
export interface TurnstileSolution { token: string; type?: "turnstile"; userAgent?: string }
export interface TextSolution { text?: string; answers?: string[] }
export interface GridSolution { type: "multi" | "single"; objects?: number[]; size: number; hasObject?: boolean }
export interface AwsWafSolution { objects: number[] }
export interface SliderSolution { distance: number }
export interface GeeTestSlideSolution { distance: number; x: number }
export interface CloudflareSolution { cookies: Record<string, string>; token: string; type?: "challenge"; userAgent?: string }
/** TextCaptchaTask: the answer to type, and other spellings of it. */
export interface TextQuestionSolution { text: string; alternatives?: string[] }
/** DragDropTask: one place per piece, in the order the pieces were sent (null when a piece has no place). */
export interface DragDropSolution { coordinates: ({ x: number; y: number } | null)[]; centers: ({ x: number; y: number } | null)[] }
/** BoundingBoxTask: boxes in the picture's pixels. */
export interface BoundingBoxSolution { bounding_boxes: { xMin: number; yMin: number; xMax: number; yMax: number }[] }

/** What a solve cost, as the API states it. */
export interface CaptchaCost { charged: boolean; amount: number; unit: "credits" | "usd"; credits?: number; refunded?: number; note?: string }

/** One entry of the type catalogue (GET /types). */
export interface CaptchaTypeInfo {
  type: string; title: string; summary: string; kind: "recognition" | "token"; status: "live" | "off"; offReason?: string;
  required: { name: string; type: string; description: string }[];
  optional: { name: string; type: string; description: string }[];
  price: { usdPer1000: number; creditsPerSolve: number };
  measured: { row: string; attempts: number; passes: number; passRate: number; medianSeconds: number | null; measuredOn: string; exit?: string }[];
  [k: string]: unknown;
}

/** The answer to a report. */
export interface CaptchaReport { taskId: string; outcome: "correct" | "incorrect"; refunded: boolean; refund: { amount: number; unit: string }; message: string }

/** A task object for createTask. `S` is the solution shape it returns (type only). */
export type CaptchaTask<S = Record<string, unknown>> = { type: string; [field: string]: unknown } & { readonly __solution?: S };

/** A solution, with the task id, its cost and its time as non-enumerable `taskId`, `cost`, `solveSeconds`. */
export type Solved<S> = S & { readonly taskId: string; readonly cost?: CaptchaCost; readonly solveSeconds?: number };

/** Browsa's proxy object, or a "http://user:pass@host:port" / "http:host:port:user:pass" string. */
export type CaptchaProxy = string | { type?: string; host: string; port: number; username?: string; password?: string };

// ── Task type names of other services ───────────────────────────────────

const ALIASES = new Map<string, [string, string]>();
function alias(names: string[], proxyless: string, withProxy?: string) {
  for (const n of names) ALIASES.set(n.toLowerCase(), [proxyless, withProxy ?? proxyless]);
}
alias(["ImageToTextTask"], "ImageToTextTask");
alias(["ReCaptchaV2Classification"], "ReCaptchaV2Classification");
alias(["AwsWafClassification"], "AwsWafClassification");
alias(["VisionEngine"], "VisionEngine");
alias(["GeeTestSlide"], "GeeTestSlide");
alias(["RotateTask"], "RotateTask");
alias(["ClickOrderTask"], "ClickOrderTask");
alias(["AltchaTask", "altcha"], "AltchaTask");
alias(["TextCaptchaTask"], "TextCaptchaTask");
alias(["BoundingBoxTask"], "BoundingBoxTask");
alias(["DrawAroundTask"], "DrawAroundTask");
alias(["DragDropTask"], "DragDropTask");
alias(["AntiCloudflareTask"], "AntiCloudflareTask");
alias(["ReCaptchaV2TaskProxyLess", "NoCaptchaTaskProxyless"], "ReCaptchaV2TaskProxyLess");
alias(["ReCaptchaV2EnterpriseTaskProxyLess"], "ReCaptchaV2EnterpriseTaskProxyLess");
alias(["ReCaptchaV3TaskProxyLess"], "ReCaptchaV3TaskProxyLess");
alias(["ReCaptchaV3EnterpriseTaskProxyLess"], "ReCaptchaV3EnterpriseTaskProxyLess");
alias(["AntiTurnstileTaskProxyLess", "TurnstileTaskProxyless"], "AntiTurnstileTaskProxyLess");
// Names that take a proxy: CapMonster sends them without one to mean "proxyless".
alias(["ReCaptchaV2Task", "NoCaptchaTask"], "ReCaptchaV2TaskProxyLess", "ReCaptchaV2Task");
alias(["ReCaptchaV2EnterpriseTask"], "ReCaptchaV2EnterpriseTaskProxyLess", "ReCaptchaV2EnterpriseTask");
alias(["ReCaptchaV3Task"], "ReCaptchaV3TaskProxyLess", "ReCaptchaV3Task");
alias(["ReCaptchaV3EnterpriseTask"], "ReCaptchaV3EnterpriseTaskProxyLess", "ReCaptchaV3EnterpriseTask");
alias(["AntiTurnstileTask", "TurnstileTask"], "AntiTurnstileTaskProxyLess", "AntiTurnstileTask");

/**
 * A copy of `task` in Browsa's names: any of the four services' type names, in
 * any letter case (RecaptchaV2TaskProxyless, TurnstileTask, NoCaptchaTaskProxyless...);
 * a proxy type without a proxy becomes proxyless (CapMonster's meaning); Turnstile's
 * action/pageAction and cData/data move into metadata. Unknown types are left as they are.
 */
export function normalizeCaptchaTask<T extends Record<string, unknown>>(task: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...task };
  if (typeof out.type !== "string") return out;
  if (out.cloudflareTaskType === "cf_clearance" || out.cloudflareTaskType === "wait_room") return out;
  const pair = ALIASES.get(out.type.toLowerCase());
  if (pair) out.type = out.proxy || out.proxyAddress ? pair[1] : pair[0];
  if ((out.type as string).includes("Turnstile")) {
    const meta: Record<string, unknown> = { ...((out.metadata as Record<string, unknown>) ?? {}) };
    const action = out.action || out.pageAction;
    const cdata = out.cData || out.data;
    delete out.action; delete out.pageAction; delete out.cData; delete out.data;
    if (action && meta.action == null) meta.action = action;
    if (cdata && meta.cdata == null) meta.cdata = cdata;
    if (Object.keys(meta).length) out.metadata = meta;
  }
  return out;
}

// ── Builders ─────────────────────────────────────────────────────────────

type ImageInput = Uint8Array | ArrayBuffer | string;

function b64(img: ImageInput): string {
  if (typeof img === "string") return img; // base64 or a data: URL
  const bytes = img instanceof Uint8Array ? img : new Uint8Array(img);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** "http://user:pass@host:port" from a string (kept as it is) or Browsa's proxy object. */
export function captchaProxyString(p?: CaptchaProxy | null): string | undefined {
  if (!p) return undefined;
  if (typeof p === "string") return p;
  if (!p.host || !p.port) throw new TypeError("proxy needs a host and a port");
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? "")}@` : "";
  return `${(p.type ?? "http").toLowerCase()}://${auth}${p.host}:${p.port}`;
}

function token<S>(base: string, websiteURL: string, websiteKey: string, proxy: CaptchaProxy | undefined,
  fields: Record<string, unknown>): CaptchaTask<S> {
  if (!websiteURL || !websiteKey) throw new TypeError("websiteURL and websiteKey are required");
  const p = captchaProxyString(proxy);
  const task: Record<string, unknown> = { type: p ? base : base + "ProxyLess", websiteURL, websiteKey };
  if (p) task.proxy = p;
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === false || v === "" || (typeof v === "object" && !Object.keys(v as object).length)) continue;
    task[k] = v;
  }
  return task as CaptchaTask<S>;
}

export const captchaTasks = {
  /** Read the characters in a text captcha (one image, or up to 9). */
  imageToText(image: ImageInput | ImageInput[], opts: { module?: string; websiteURL?: string } = {}): CaptchaTask<TextSolution> {
    const t: Record<string, unknown> = { type: "ImageToTextTask" };
    if (Array.isArray(image)) t.images = image.map(b64); else t.body = b64(image);
    if (opts.module) t.module = opts.module;
    if (opts.websiteURL) t.websiteURL = opts.websiteURL;
    return t as CaptchaTask<TextSolution>;
  },
  /** A reCAPTCHA v2 token. */
  recaptchaV2(websiteURL: string, websiteKey: string, opts: {
    invisible?: boolean; enterprise?: boolean; apiDomain?: string; enterprisePayload?: Record<string, unknown>; proxy?: CaptchaProxy;
  } = {}): CaptchaTask<TokenSolution> {
    return token(opts.enterprise ? "ReCaptchaV2EnterpriseTask" : "ReCaptchaV2Task", websiteURL, websiteKey, opts.proxy,
      { isInvisible: opts.invisible, apiDomain: opts.apiDomain, enterprisePayload: opts.enterprisePayload });
  },
  /** A reCAPTCHA v3 token. `minScore` is accepted and not guaranteed. */
  recaptchaV3(websiteURL: string, websiteKey: string, opts: {
    pageAction?: string; enterprise?: boolean; minScore?: number; apiDomain?: string; proxy?: CaptchaProxy;
  } = {}): CaptchaTask<TokenSolution> {
    return token(opts.enterprise ? "ReCaptchaV3EnterpriseTask" : "ReCaptchaV3Task", websiteURL, websiteKey, opts.proxy,
      { pageAction: opts.pageAction, minScore: opts.minScore, apiDomain: opts.apiDomain });
  },
  /** A Cloudflare Turnstile token. */
  turnstile(websiteURL: string, websiteKey: string, opts: { action?: string; cdata?: string; proxy?: CaptchaProxy } = {}): CaptchaTask<TurnstileSolution> {
    const metadata: Record<string, unknown> = {};
    if (opts.action) metadata.action = opts.action;
    if (opts.cdata) metadata.cdata = opts.cdata;
    return token("AntiTurnstileTask", websiteURL, websiteKey, opts.proxy, { metadata });
  },
  /** Which tiles of a reCAPTCHA v2 grid show `question` (a /m/... id or plain words). */
  recaptchaV2Classification(image: ImageInput, question: string, opts: { size?: 1 | 3 | 4; websiteURL?: string } = {}): CaptchaTask<GridSolution> {
    if (opts.size != null && ![1, 3, 4].includes(opts.size)) throw new TypeError("size must be 1, 3 or 4");
    const t: Record<string, unknown> = { type: "ReCaptchaV2Classification", image: b64(image), question };
    if (opts.size) t.size = opts.size;
    if (opts.websiteURL) t.websiteURL = opts.websiteURL;
    return t as CaptchaTask<GridSolution>;
  },
  /** Which tiles of an AWS WAF grid show the object. */
  awsWafClassification(images: ImageInput[], question: string): CaptchaTask<AwsWafSolution> {
    return { type: "AwsWafClassification", images: images.map(b64),
      question: question.startsWith("aws:grid:") ? question : `aws:grid:${question}` } as CaptchaTask<AwsWafSolution>;
  },
  /** The gap of a slider puzzle (VisionEngine slider_1). Off on the API until a measured run passes. */
  slider(imageBackground: ImageInput, image?: ImageInput): CaptchaTask<SliderSolution> {
    const t: Record<string, unknown> = { type: "VisionEngine", module: "slider_1", imageBackground: b64(imageBackground) };
    if (image != null) t.image = b64(image);
    return t as CaptchaTask<SliderSolution>;
  },
  /** How far to drag a GeeTest v3 slide puzzle, from the two pictures it serves, as downloaded. */
  geetestSlideV3(imageBackground: ImageInput, imageFull: ImageInput, opts: { cssWidth?: number; shuffled?: boolean } = {}): CaptchaTask<GeeTestSlideSolution> {
    const t: Record<string, unknown> = { type: "GeeTestSlide", version: 3, imageBackground: b64(imageBackground), imageFull: b64(imageFull) };
    if (opts.cssWidth != null) t.cssWidth = opts.cssWidth;
    if (opts.shuffled === false) t.shuffled = false;
    return t as CaptchaTask<GeeTestSlideSolution>;
  },
  /** How far to drag a GeeTest v4 slide puzzle: background, the piece's PNG, its top offset and the background's width (CSS px). */
  geetestSlideV4(imageBackground: ImageInput, imageSlice: ImageInput, opts: { top: number; bgCssWidth: number; sliceCssWidth?: number }): CaptchaTask<GeeTestSlideSolution> {
    const t: Record<string, unknown> = { type: "GeeTestSlide", version: 4, imageBackground: b64(imageBackground),
      imageSlice: b64(imageSlice), top: opts.top, bgCssWidth: opts.bgCssWidth };
    if (opts.sliceCssWidth != null) t.sliceCssWidth = opts.sliceCssWidth;
    return t as CaptchaTask<GeeTestSlideSolution>;
  },
  /** The answer to an anti-spam question asked in words (TextCaptchaTask), up to 600 characters. No picture. */
  textQuestion(question: string, opts: { websiteURL?: string } = {}): CaptchaTask<TextQuestionSolution> {
    if (!question || !question.trim()) throw new TypeError("question is required");
    const t: Record<string, unknown> = { type: "TextCaptchaTask", comment: question };
    if (opts.websiteURL) t.websiteURL = opts.websiteURL;
    return t as CaptchaTask<TextQuestionSolution>;
  },
  /** Where each piece goes in the background picture (DragDropTask): 1 to 6 piece pictures, in order. You do the dragging. */
  dragDrop(imageBackground: ImageInput, pieces: ImageInput[], opts: { websiteURL?: string } = {}): CaptchaTask<DragDropSolution> {
    if (!Array.isArray(pieces) || pieces.length < 1 || pieces.length > 6) throw new TypeError("pieces must be an array of 1 to 6 pictures");
    const t: Record<string, unknown> = { type: "DragDropTask", body: b64(imageBackground), pieces: pieces.map(b64) };
    if (opts.websiteURL) t.websiteURL = opts.websiteURL;
    return t as CaptchaTask<DragDropSolution>;
  },
  /** A tight box around what `instruction` names, in the picture's pixels (BoundingBoxTask). `many`: every matching thing. */
  boundingBox(image: ImageInput, instruction: string, opts: { many?: boolean; websiteURL?: string } = {}): CaptchaTask<BoundingBoxSolution> {
    if (!instruction || !instruction.trim()) throw new TypeError("instruction is required");
    const t: Record<string, unknown> = { type: "BoundingBoxTask", body: b64(image), comment: instruction };
    if (opts.many) t.many = true;
    if (opts.websiteURL) t.websiteURL = opts.websiteURL;
    return t as CaptchaTask<BoundingBoxSolution>;
  },
  /** Pass a page's Cloudflare full-page check through your proxy (required: the cookie only works from the address that passed). */
  cloudflareChallenge(websiteURL: string, proxy: CaptchaProxy, opts: { userAgent?: string } = {}): CaptchaTask<CloudflareSolution> {
    const p = captchaProxyString(proxy);
    if (!websiteURL || !p) throw new TypeError("websiteURL and proxy are required");
    const t: Record<string, unknown> = { type: "AntiCloudflareTask", websiteURL, proxy: p };
    if (opts.userAgent) t.userAgent = opts.userAgent;
    return t as CaptchaTask<CloudflareSolution>;
  },
};

// ── Client ───────────────────────────────────────────────────────────────

export interface CaptchaClientOptions {
  /** Your Browsa API key; default process.env.BROWSA_API_KEY. */
  apiKey?: string;
  /** Default process.env.BROWSA_CAPTCHA_URL or https://captcha.browsa.io. */
  baseUrl?: string;
  /** One HTTP request, ms. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Map other services' task type names to Browsa's (default true). */
  normalize?: boolean;
  /** How long the API is asked to hold each call in solve(), seconds (default 20, at most 25;
   * 0 polls every pollIntervalMs instead). */
  waitSeconds?: number;
  fetch?: typeof fetch;
}

export interface CaptchaAnswer {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: string;
  status?: "processing" | "ready" | "failed";
  solution?: Record<string, unknown>;
  cost?: CaptchaCost;
  solveSeconds?: number;
  balance?: number;
  [k: string]: unknown;
}

const env = (k: string): string | undefined =>
  typeof process !== "undefined" && process.env ? process.env[k] || undefined : undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CaptchaClient {
  readonly baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private pollIntervalMs: number;
  private normalize: boolean;
  private waitSeconds: number;
  private fetchImpl: typeof fetch;

  constructor(opts: CaptchaClientOptions = {}) {
    const key = opts.apiKey || env("BROWSA_API_KEY");
    if (!key) throw new TypeError("apiKey is required: pass apiKey or set BROWSA_API_KEY. Create a key at https://app.browsa.io/dashboard/keys");
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl || env("BROWSA_CAPTCHA_URL") || DEFAULT_CAPTCHA_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.normalize = opts.normalize ?? true;
    // never longer than one HTTP request can last
    this.waitSeconds = Math.max(0, Math.min(opts.waitSeconds ?? DEFAULT_WAIT_SECONDS, 25, this.timeoutMs / 1000 - 5));
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** POST /{method} with clientKey added; resolves the answer or throws CaptchaError. */
  call(method: string, payload: Record<string, unknown> = {}): Promise<CaptchaAnswer> {
    return this.send(method, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ clientKey: this.apiKey, ...payload }),
    });
  }

  private async send(path: string, init: RequestInit): Promise<CaptchaAnswer> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}/${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const err = e as Error;
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new TimeoutError(`request timed out after ${this.timeoutMs}ms`);
      }
      throw new BrowsaError(`network error: ${err?.message ?? String(e)}`);
    }
    const body: any = await resp.json().catch(() => null);
    if (!body || typeof body !== "object" || !("errorId" in body)) {
      throw new CaptchaError(`unexpected answer (HTTP ${resp.status})`, { code: `HTTP_${resp.status}`, status: resp.status, body });
    }
    if (body.errorId) {
      throw new CaptchaError(body.errorDescription || body.errorCode || "error",
        { code: body.errorCode || undefined, taskId: body.taskId, status: resp.status, body });
    }
    return body as CaptchaAnswer;
  }

  /**
   * {taskId, status: "ready", solution} for recognition, {taskId} for tokens.
   * `waitSeconds`: hold the call until a token task ends or the wait runs out (then status is
   * "ready" with the solution, or "processing").
   *
   * `callbackUrl`: the API also POSTs the finished answer (the JSON getTaskResult gives) to this
   * public https URL, signed. The receiver has three jobs:
   * 1. Once per host, the API first POSTs {"type": "callback.verify", "challenge": "..."} and the
   *    endpoint must answer 2xx with JSON {"challenge": "<the same value>"}. Until it has,
   *    createTask throws ERROR_INVALID_CALLBACK_URL (no task, no charge).
   * 2. Check every delivery: verifySignature(rawBody, headers["x-browsa-signature"],
   *    await cap.callbackSecret()) from "browsa/webhooks".
   * 3. De-duplicate on the body's taskId: a delivery can arrive more than once.
   * One host receives at most 60 requests a minute. The result stays in getTaskResult for
   * 10 minutes whether or not the callback arrives.
   */
  createTask(task: CaptchaTask<any> | Record<string, unknown>, opts: { waitSeconds?: number; callbackUrl?: string } = {}): Promise<CaptchaAnswer> {
    const t = this.normalize ? normalizeCaptchaTask(task as Record<string, unknown>) : { ...task };
    const payload: Record<string, unknown> = { task: t };
    if (opts.waitSeconds) payload.waitSeconds = opts.waitSeconds;
    if (opts.callbackUrl) payload.callbackUrl = opts.callbackUrl;
    return this.call("createTask", payload);
  }

  /** {status: "processing"} or {status: "ready", solution, cost, solveSeconds}; a failed task throws.
   * `waitSeconds` (up to 25): the call is held until the task ends. */
  getTaskResult(taskId: string, opts: { waitSeconds?: number } = {}): Promise<CaptchaAnswer> {
    return this.call("getTaskResult", opts.waitSeconds ? { taskId, waitSeconds: opts.waitSeconds } : { taskId });
  }

  /** Tell the API whether the site took the solution. One report per task, within 15 minutes of the
   * solve. An incorrect report refunds that solve once, within the workspace's report limits:
   * `refunded` in the answer says whether a refund was made. Throws CaptchaError (ERROR_ALREADY_REPORTED,
   * ERROR_REPORT_TOO_LATE, ERROR_REPORT_LIMIT). */
  async report(taskId: string, correct: boolean): Promise<CaptchaReport> {
    return (await this.call(correct ? "reportCorrect" : "reportIncorrect", { taskId })) as unknown as CaptchaReport;
  }
  reportCorrect(taskId: string): Promise<CaptchaReport> { return this.report(taskId, true); }
  reportIncorrect(taskId: string): Promise<CaptchaReport> { return this.report(taskId, false); }

  /** Every task type the API accepts (no key is sent): status, parameters, price, measured numbers. */
  async listTypes(): Promise<CaptchaTypeInfo[]> {
    const r = await this.send("types", { method: "GET", headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
    return (r.types as CaptchaTypeInfo[]) ?? [];
  }

  /** The secret this account's callbacks are signed with, as hex (made on first use).
   * Pass it to `verifySignature` from "browsa/webhooks" as it is. */
  async callbackSecret(): Promise<string> {
    return String((await this.call("getCallbackSecret")).secret ?? "");
  }

  /** Replace the callback secret and return the new one. Deliveries are signed with the new
   * secret from then on, so update the receiver at the same time. */
  async rotateCallbackSecret(): Promise<string> {
    return String((await this.call("rotateCallbackSecret")).secret ?? "");
  }

  /** Balance: credits with a Browsa key. */
  async getBalance(): Promise<number> {
    return Number((await this.call("getBalance")).balance ?? 0);
  }

  /**
   * Create the task and wait for its solution. It does not poll on a timer: each call asks the
   * API to hold until the task ends (waitSeconds), so the answer arrives when it exists. Against a
   * server that does not hold calls it polls every pollIntervalMs.
   * `callbackUrl`: the API also POSTs the answer there (see createTask).
   */
  async solve<S = Record<string, unknown>>(task: CaptchaTask<S> | Record<string, unknown>,
    opts: { timeoutMs?: number; pollIntervalMs?: number; callbackUrl?: string } = {}): Promise<Solved<S>> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SOLVE_TIMEOUT;
    const deadline = Date.now() + timeoutMs;
    const firstWait = Math.min(this.waitSeconds, timeoutMs / 1000);
    const created = await this.createTask(task, { waitSeconds: firstWait || undefined, callbackUrl: opts.callbackUrl });
    const taskId = String(created.taskId ?? "");
    if (created.status === "ready" && created.solution) return withId<S>(created, taskId);
    if (!taskId) throw new CaptchaError("createTask returned no taskId", { code: "ERROR_NO_TASK_ID", body: created });
    const interval = opts.pollIntervalMs ?? this.pollIntervalMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new CaptchaTimeoutError(`no solution after ${Math.round(timeoutMs / 1000)}s`, { taskId });
      let held = Math.min(this.waitSeconds, left / 1000);
      if (held < 1) {                           // not asking the API to hold: wait here, as before
        await sleep(Math.min(interval, left));
        held = 0;
      }
      const asked = Date.now();
      const r = await this.getTaskResult(taskId, { waitSeconds: held || undefined });
      if (r.status === "ready" && r.solution) return withId<S>(r, taskId);
      if (held && Date.now() - asked < Math.min(1000, held * 1000)) {
        // answered at once though asked to hold (an older server): do not spin
        await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      }
    }
  }
}

function withId<S>(answer: CaptchaAnswer, taskId: string): Solved<S> {
  const s = { ...(answer.solution ?? {}) };
  Object.defineProperty(s, "taskId", { value: taskId, enumerable: false });
  Object.defineProperty(s, "cost", { value: answer.cost, enumerable: false });
  Object.defineProperty(s, "solveSeconds", { value: answer.solveSeconds, enumerable: false });
  return s as unknown as Solved<S>;
}

// ── 2Captcha shim ────────────────────────────────────────────────────────

/** 2Captcha's answer shape. */
export interface TwoCaptchaAnswer { data: string; id: string }

function twoCaptchaProxy(proxy?: string, proxytype?: string): string | undefined {
  if (!proxy) return undefined;
  if (proxy.includes("://")) return proxy;
  return `${(proxytype || "http").toLowerCase()}://${proxy}`;
}

/**
 * Drop-in for `Solver` from @2captcha/captcha-solver on the types Browsa solves:
 * recaptcha, imageCaptcha, cloudflareTurnstile, balance. Same parameters, same
 * `{ data, id }` answer. That library always calls 2captcha.com, so change the import:
 *
 *     // before: import { Solver } from "@2captcha/captcha-solver";
 *     import { TwoCaptchaSolver as Solver } from "browsa";
 *     const solver = new Solver("agt_live_...");
 */
export class TwoCaptchaSolver {
  private cap: CaptchaClient;
  constructor(apikey: string, pollingFrequency = 5000, opts: Omit<CaptchaClientOptions, "apiKey"> = {}) {
    this.cap = new CaptchaClient({ pollIntervalMs: Math.min(pollingFrequency, 5000), ...opts, apiKey: apikey });
  }

  async balance(): Promise<number> {
    return this.cap.getBalance();
  }

  /** The site took the answer (same call as the library's goodReport). */
  goodReport(id: string): Promise<CaptchaReport> { return this.cap.reportCorrect(id); }
  /** The site refused the answer (same call as the library's badReport): that solve is refunded once,
   * within the workspace's report limits (`refunded` in the answer). */
  badReport(id: string): Promise<CaptchaReport> { return this.cap.reportIncorrect(id); }

  async recaptcha(params: {
    pageurl: string; googlekey: string; invisible?: 0 | 1 | boolean; version?: string; action?: string;
    enterprise?: 0 | 1 | boolean; min_score?: number; domain?: string; proxy?: string; proxytype?: string;
  }): Promise<TwoCaptchaAnswer> {
    if (!params?.pageurl || !params?.googlekey) throw new CaptchaError("pageurl and googlekey are required", { code: "ERROR_INVALID_TASK_DATA" });
    const proxy = twoCaptchaProxy(params.proxy, params.proxytype);
    const task = String(params.version ?? "v2").toLowerCase() === "v3"
      ? captchaTasks.recaptchaV3(params.pageurl, params.googlekey, { pageAction: params.action, enterprise: !!params.enterprise, minScore: params.min_score, proxy })
      : captchaTasks.recaptchaV2(params.pageurl, params.googlekey, { invisible: !!params.invisible, enterprise: !!params.enterprise, apiDomain: params.domain, proxy });
    const s = await this.cap.solve(task, { timeoutMs: 600_000 });
    return { data: s.gRecaptchaResponse, id: s.taskId };
  }

  async imageCaptcha(params: { body: string }): Promise<TwoCaptchaAnswer> {
    if (!params?.body) throw new CaptchaError("body is required", { code: "ERROR_INVALID_TASK_DATA" });
    const s = await this.cap.solve(captchaTasks.imageToText(params.body), { timeoutMs: 120_000 });
    return { data: s.text ?? (s.answers ?? []).join(","), id: s.taskId };
  }

  async cloudflareTurnstile(params: { pageurl: string; sitekey: string; action?: string; data?: string; proxy?: string; proxytype?: string }): Promise<TwoCaptchaAnswer> {
    if (!params?.pageurl || !params?.sitekey) throw new CaptchaError("pageurl and sitekey are required", { code: "ERROR_INVALID_TASK_DATA" });
    const s = await this.cap.solve(captchaTasks.turnstile(params.pageurl, params.sitekey,
      { action: params.action, cdata: params.data, proxy: twoCaptchaProxy(params.proxy, params.proxytype) }), { timeoutMs: 180_000 });
    return { data: s.token, id: s.taskId };
  }
}

// ── Anti-Captcha bridge ──────────────────────────────────────────────────

/**
 * Send @antiadmin/anticaptchaofficial's requests to Browsa. Its host is written in
 * the code; this replaces its JSONRequest so the rest of your code stays:
 *
 *     const ac = require("@antiadmin/anticaptchaofficial");
 *     useWithAntiCaptcha(ac);
 *     ac.setAPIKey("agt_live_...");                 // your Browsa key
 *     const token = await ac.solveRecaptchaV2Proxyless(url, sitekey);
 *
 * Task type names are mapped to Browsa's on the way. Returns a function that undoes it.
 */
export function useWithAntiCaptcha(ac: any, opts: { baseUrl?: string; fetch?: typeof fetch } = {}): () => void {
  if (!ac || typeof ac.JSONRequest !== "function") throw new TypeError("pass the @antiadmin/anticaptchaofficial module");
  const base = (opts.baseUrl || env("BROWSA_CAPTCHA_URL") || DEFAULT_CAPTCHA_URL).replace(/\/+$/, "");
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const original = ac.JSONRequest;
  // The library polls `while (taskId > 0)`: Anti-Captcha's ids are numbers and
  // Browsa's are UUIDs, so it gets a local number standing for each UUID.
  const ids = new Map<number, string>();
  let nextId = 1;
  ac.JSONRequest = async function (methodName: string, payLoad: Record<string, any>) {
    const body = { ...payLoad };
    if (methodName === "createTask" && body.task && typeof body.task === "object") {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body.task)) if (v != null) clean[k] = v;
      body.task = normalizeCaptchaTask(clean);
    }
    if (typeof body.taskId === "number" && ids.has(body.taskId)) body.taskId = ids.get(body.taskId);
    const resp = await f(`${base}/${methodName}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
    });
    const answer = await resp.json();
    if (methodName === "createTask" && answer && typeof answer.taskId === "string") {
      const n = nextId++;
      ids.set(n, answer.taskId);
      answer.taskId = n;
    }
    return this.checkForErrors(answer);
  };
  return () => { ac.JSONRequest = original; };
}
