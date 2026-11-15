/**
 * browsa — real browsers for AI agents.
 *
 * Quickstart:
 *
 *     import { Client } from "browsa";
 *
 *     const c = new Client({ apiKey: "agt_live_..." });
 *     const job = await c.runTask({
 *         task: "Go to news.ycombinator.com and return the top story title.",
 *         llm: "claude-opus-5-5",
 *         llmApiKey: "sk-ant-...",
 *     });
 *     console.log(job.finalResult);
 *     console.log("watch live:", job.liveUrl);
 *
 * Zero deps — pure Node 18+ fetch. The package ships as a small ESM+CJS
 * bundle with no transitive dependency surface, audit-friendly for
 * agencies running it inside locked-down LLM agent environments.
 */

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in milliseconds (default 30_000). */
  timeoutMs?: number;
  /** Custom fetch implementation; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "input_required";

export const TERMINAL_STATUSES: JobStatus[] = ["completed", "failed", "cancelled"];

/** A downloadable output file a task agent wrote (incl. the session.gif recording). */
export interface JobFile {
  name: string;
  size: number;
  createdAt?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  kind: string;
  stepCount: number;
  progressDone: number;
  progressTotal: number;
  framework?: string;
  liveUrl?: string;
  agentId?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  errorCode?: string;
  creditsCharged?: number;
  finalResult?: string;
  inputQuestion?: string;
  resultUrl?: string;
  statusUrl?: string;
  /** Output files the agent wrote (download via downloadJobFile). */
  files?: JobFile[];
  /** Task secrets the job was given (domain + name). Never the values. */
  secretNames?: { domain: string; name: string }[];
  /** The task text (GET /v1/jobs/:id on a task job). */
  task?: string;
  /**
   * The session this task belongs to. Set on the 202 of a task created with
   * keepBrowser (with sessionUrl) and on the 202 of sendMessage (with turn,
   * the 1-based turn number). GET /v1/jobs/:id of a turn has sessionId but
   * no turn; runMessage keeps the turn from the 202.
   */
  sessionId?: string;
  sessionUrl?: string;
  turn?: number;
  /** Saved LLM key the job used (never the secret). */
  llmKeyId?: string;
  /** Masked form of that key, e.g. "sk-ant-…a1b2". */
  llmKeyMasked?: string;
  /** "saved" when chosen by llmKeyId, "default" when the workspace default was used. */
  llmKeySource?: "saved" | "default" | string;
  /**
   * How the job ended: who or what ended it. Unset until the job is
   * finished. Sits beside status and errorCode and can say more: a task a
   * limit stopped that still returned a partial result is "completed" with
   * outcome "step_limit_reached".
   */
  outcome?: JobOutcome | string;
  /** One sentence that says how the job ended and, where there is one, what to try next. */
  outcomeMessage?: string;
  /** What was seen while the job ran, in the order it was first seen. Empty when nothing was. */
  signals: (JobSignal | string)[];
  /** started_at to completed_at in milliseconds. Unset until the job is finished. */
  durationMs?: number;
  /** The task's LLM token counts. Unset on jobs that have none (still running, or run before usage existed). */
  usage?: Usage;
  /**
   * Estimated LLM cost in USD from public list prices. null when unknown,
   * and always null for hosted runs, which are paid in credits. Unset when
   * the job has no such field.
   */
  llmCostUsd?: number | null;
  /** The hosted tier that ran the task ("browsa", "browsa-fast", "browsa-smart"). Unset with your own key. */
  llmTier?: string;
  /** The reasoning level that was applied. */
  reasoning?: Reasoning | string;
  /**
   * The tier of Browsa's built-in proxy network the job's browser went
   * through, null when it used your own proxy or none. Only where
   * proxyNetwork() reports enabled.
   */
  proxyNetwork: ProxyNetworkName | string | null;
  /** Bytes that went through the built-in proxy network. 0 without one. */
  proxyBytes: number;
  /** Credits charged for that data. 0 without one. */
  proxyCredits: number;
  /** Untyped escape hatch for fields not yet promoted to typed surface. */
  raw: Record<string, unknown>;
}

/** Your own HTTP, HTTPS or SOCKS5 proxy. Give host and port, or server as "host:port" / "scheme://[user:pass@]host:port". */
export interface ProxyConfig {
  type?: "http" | "https" | "socks5";
  host?: string;
  port?: number;
  server?: string;
  username?: string;
  password?: string;
  country?: string;
  /** Not part of the own-proxy form: see NetworkProxy. */
  network?: never;
}

/** The tiers of Browsa's built-in proxy network. */
export type ProxyNetworkName = "datacenter" | "residential";

/**
 * A tier of Browsa's built-in proxy network, billed per GB from credits:
 * `{ network: "datacenter" }` or `{ network: "residential", country: "us" }`.
 * Nothing else goes next to `network` (no host, port, server, username,
 * password or type), and no proxyId with it.
 *
 * Available only when `client.proxyNetwork()` reports `enabled`; its tiers
 * list the networks, their countries and the price per GB.
 */
export interface NetworkProxy {
  network: ProxyNetworkName;
  /** Lowercase ISO alpha-2 exit country, one of the tier's `countries`. Optional. */
  country?: string;
  type?: never; host?: never; port?: never; server?: never; username?: never; password?: never;
}

/** The `proxy` of a task, a schedule or a browser: your own proxy, or a built-in network tier. */
export type Proxy = ProxyConfig | NetworkProxy;

/** One tier of the built-in proxy network (GET /v1/proxy-network). */
export interface ProxyNetworkTier {
  network: ProxyNetworkName | string;
  /** Price: credits per GB of data through this tier. */
  creditsPerGb?: number;
  /** The same price the other way round: MB of data one credit pays for. */
  mbPerCredit?: number;
  /** Lowercase ISO alpha-2 exit countries this tier offers. */
  countries: string[];
}

/** GET /v1/proxy-network: whether the built-in network is on, and its tiers. */
export interface ProxyNetwork {
  enabled: boolean;
  tiers: ProxyNetworkTier[];
  raw: Record<string, unknown>;
}

/** How much the model reasons. Unset: the hosted tier's or the provider's default. */
export type Reasoning = "low" | "medium" | "high";

/** LLM token use of a finished task (Job.usage). Counts the server did not send are 0. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Number of LLM requests the task made. */
  requests: number;
}

/**
 * One hosted tier from GET /v1/models. The model, fallbacks, default
 * reasoning and credits are server settings and can change.
 */
export interface HostedModel {
  /** What to pass as `llm`: "browsa", "browsa-fast" or "browsa-smart". */
  id: string;
  /** The model the tier runs on now. */
  model: string;
  /** What it falls back to, in order. */
  fallbackModels: string[];
  /** The tier's default reasoning level; null means the model's own default. */
  reasoning: Reasoning | string | null;
  /** Flat number of credits the tier adds to a task. Unset if the server did not say. */
  creditsPerTask?: number;
  /** True for the default hosted model. */
  default: boolean;
}

/** GET /v1/models: the hosted tiers and what runs with your own key. */
export interface Models {
  hosted: HostedModel[];
  ownKey: {
    /** Providers you can bring a key for. */
    providers: (LLMKeyProvider | string)[];
    /** The model used for each provider when `llm` is omitted. */
    defaultModels: Record<string, string>;
  };
  raw: Record<string, unknown>;
}

/** How a job ended (Job.outcome). */
export type JobOutcome =
  | "completed"
  | "failed"
  | "cancelled_by_user"
  | "timed_out"
  | "step_limit_reached"
  | "budget_reached"
  | "blocked_by_bot_check"
  | "never_started"
  | "stalled";

/** Something seen while a job ran (Job.signals). */
export type JobSignal =
  | "bot_check_seen"
  | "bot_check_passed"
  | "captcha_seen"
  | "proxy_failed"
  | "navigation_failed"
  | "llm_error"
  | "llm_fallback_used"
  | "human_input_requested"
  | "file_produced"
  | "partial_result"
  | "step_error";

export type SessionStatus = "running" | "idle" | "closed";

/** One message in a session and the agent's answer. */
export interface SessionTurn {
  jobId: string;
  task: string;
  status: JobStatus;
  finalResult: string | null;
  errorCode?: string;
  errorMessage?: string;
  stepCount: number;
  durationSeconds: number | null;
  creditsCharged: number;
  llm?: string;
  liveUrl?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
}

/** The session's browser right now. */
export interface SessionBrowser {
  status: "starting" | "live" | "closed";
  /** "burner" or "persistent" (an identity); undefined until known. */
  mode?: "burner" | "persistent";
  liveUrl?: string;
  expiresAt?: string;
  expiresInSeconds?: number;
  /** Credits paid for the browser: 5 for a burner, 1 per identity session. */
  credits: number;
}

/** GET /v1/sessions/:id: follow-up messages on the same browser. */
export interface Session {
  id: string;
  title: string;
  /** "running" while a turn is queued or running, "idle" when it takes a follow-up now, "closed" when its browser is gone. */
  status: SessionStatus;
  /** True when sendMessage would queue a turn now. */
  acceptsMessages: boolean;
  closedReason?: "expired" | "stopped" | "failed" | "single_task";
  keepBrowser: boolean;
  agentId?: string;
  browser: SessionBrowser;
  creditsCharged: number;
  turnCount: number;
  turns: SessionTurn[];
  createdAt?: string;
  raw: Record<string, unknown>;
}

/** Body of POST /v1/sessions/:id/messages, besides the task. */
export interface SendMessageOptions {
  /** Left out: the previous turn's model. "browsa", "browsa-fast" and "browsa-smart" are the hosted tiers. */
  llm?: string;
  /** Reasoning level for this turn. See CreateTaskOptions.reasoning. */
  reasoning?: Reasoning;
  /** BYOK key. Send it again on every message: keys are deleted when a task ends. */
  llmApiKey?: string;
  llmBaseUrl?: string;
  /** A saved LLM key. Left out (same model): the previous turn's saved key, else the workspace default. */
  llmKeyId?: string;
  maxSteps?: number;
  /** Accepted and ignored by the API. Use maxCredits to cap what a turn may charge. */
  maxCostUsd?: number;
  /** Most credits this turn may charge. See CreateTaskOptions.maxCredits. */
  maxCredits?: number;
  /** Same shape as CreateTaskOptions.secrets. */
  secrets?: Record<string, Record<string, string>>;
  /** Dedupes retries for 24h: a retried send returns the same turn. */
  idempotencyKey?: string;
}

/** A recurring scheduled task. */
export interface Schedule {
  id: string;
  name?: string;
  task?: string;
  llm?: string;
  intervalSeconds: number;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  lastJobId?: string;
  runCount: number;
  createdAt?: string;
  /** Saved LLM key the schedule runs with (the schedule stores no secret). */
  llmKeyId?: string;
  /** Reasoning level its runs use. Unset: the tier's or provider's default. */
  reasoning?: Reasoning | string;
  raw: Record<string, unknown>;
}

export type LLMKeyProvider = "anthropic" | "openai" | "google" | "openai_compatible";

/**
 * A saved LLM provider key. The API never returns the secret: `masked` is
 * the known prefix plus the last 4 characters (e.g. "sk-ant-…a1b2").
 */
export interface LLMKey {
  id: string;
  /** "" when not set. */
  name: string;
  provider: LLMKeyProvider | string;
  masked: string;
  /** Set for openai_compatible (and optionally the others). */
  baseUrl: string | null;
  isDefault: boolean;
  status: "valid" | "invalid" | "unchecked" | string;
  statusDetail?:
    | "ok" | "invalid_key" | "insufficient_quota" | "rate_limited"
    | "provider_unreachable" | "unexpected_response" | "not_checked" | string;
  /** Plain-language text for statusDetail. */
  statusMessage?: string;
  lastValidatedAt: string | null;
  lastUsedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
  raw: Record<string, unknown>;
}

export interface CreateLLMKeyOptions {
  provider: LLMKeyProvider;
  /** The provider secret. Sent once; never returned by the API. */
  apiKey: string;
  name?: string;
  /** Required for openai_compatible: a public http(s) URL. */
  baseUrl?: string;
  /**
   * true makes it the default for its provider (unsets the previous one).
   * Omitted: it becomes the default only if it is the first key of that provider.
   */
  default?: boolean;
}

export interface RotateLLMKeyOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface UpdateLLMKeyOptions {
  name?: string;
  /** true sets the default flag; false removes it. */
  default?: boolean;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  createdAt?: string;
  lastSentAt?: string;
  lastError?: string;
  disabledAt?: string;
  raw: Record<string, unknown>;
}

export interface CreateTaskOptions {
  task: string;
  /**
   * Model id (e.g. "anthropic:claude-sonnet-5-5") to run with your own key,
   * or a hosted tier: "browsa" (the default hosted model), "browsa-fast"
   * (fastest and lightest) or "browsa-smart" (for harder tasks). Hosted
   * tiers need no LLM key and add a flat number of credits per task;
   * models() lists them and what they cost. May be omitted when the
   * workspace has a default saved key: the first default in the order
   * anthropic, openai, google is used with that provider's default model.
   */
  llm?: string;
  /**
   * How much the model reasons: "low", "medium" or "high". Omit for the
   * tier's or the provider's default. The API answers 400 for any other
   * value. The finished job has the level that was applied as `reasoning`.
   */
  reasoning?: Reasoning;
  /**
   * Per-task LLM key. Which key a task uses, first match wins: llmApiKey,
   * then llmKeyId, then the workspace's default saved key for the provider
   * of `llm`, then a hosted tier (llm "browsa", "browsa-fast", "browsa-smart").
   */
  llmApiKey?: string;
  /** Id of a saved LLM key of this workspace (see createLlmKey). */
  llmKeyId?: string;
  framework?: string;
  llmBaseUrl?: string;
  country?: string;
  osType?: string;
  maxSteps?: number;
  /**
   * Most credits this task may charge (its browser, base and step credits,
   * and the hosted-model surcharge). The task stops before the step that
   * would go over it: with a partial result it completes with `partial`,
   * otherwise it fails with error_code MAX_CREDITS_REACHED and keeps its
   * browser charge. At least 7 on a new browser (3 with profileId), plus
   * the hosted tier's creditsPerTask (see models()) when llm is a hosted
   * tier; at most 10000. Omit for no cap.
   */
  maxCredits?: number;
  ja3Profile?: string;
  initialUrl?: string;
  profileId?: string;
  webhookUrl?: string;
  /**
   * Credentials the agent can type by name without the model reading them:
   * `{ "<domain>": { "<name>": "<value>" } }`, e.g.
   * `{ "*.example.com": { x_password: process.env.EXAMPLE_PASSWORD! } }`.
   * Refer to a secret in the task by its name ("log in with x_password").
   * The model is given only the names; a value is typed only on pages whose
   * URL matches its domain ("example.com" = https://example.com,
   * "*.example.com" = it and its subdomains). Up to 20 secrets; names are
   * a-z, 0-9 and _ (max 40); values are 3 to 512 characters. Encrypted at
   * rest and deleted when the task ends; the job shows only `secretNames`.
   */
  secrets?: Record<string, Record<string, string>>;
  /**
   * Start a session: the browser stays up after the task ends, until
   * browserTtlSeconds after it launched, so sendMessage can run follow-ups
   * on it. The job then has sessionId (equal to its id) and sessionUrl.
   * Same price as a normal task browser. See createSession.
   */
  keepBrowser?: boolean;
  /** How long a kept browser lives from launch: 300 to 3600, default 900. Only with keepBrowser. */
  browserTtlSeconds?: number;
  /**
   * The proxy of the task's browser: your own (`{ type, host, port, ... }`)
   * or a tier of Browsa's built-in network (`{ network: "datacenter",
   * country: "us" }`, only when proxyNetwork() reports enabled).
   */
  proxy?: Proxy;
  /** A saved proxy instead of `proxy` (not both, and not with a network). */
  proxyId?: string;
  /** Pass-through for fields we haven't typed yet. */
  [extra: string]: unknown;
}

/** Create a recurring schedule: a task payload + name + interval. */
export interface CreateScheduleOptions extends CreateTaskOptions {
  name?: string;
  /** Run interval in seconds. Must be 3600 (1h) – 2592000 (30d). */
  intervalSeconds: number;
}

export interface WaitOptions {
  /** Total wall-clock ms to wait for the job to reach a terminal state. */
  timeoutMs?: number;
  /** Backoff between polls (ms). Default 2000. */
  pollMs?: number;
  /** Called after every poll — great for progress bars. */
  onProgress?: (job: Job) => void;
}

/** One agent step from GET /v1/jobs/:id/events (snake_case, as the API sends it). */
export interface JobStepEvent {
  type: "step";
  /** Step number; the resume cursor. */
  n: number;
  /** Unix seconds when the step ended. */
  t?: number;
  action?: string;
  url?: string;
  goal?: string;
  result?: string;
  [k: string]: unknown;
}

/** The last event of a stream, sent once the job is completed or failed. */
export interface JobStatusEvent {
  type: "status";
  status: JobStatus;
  error_code: string | null;
  /** How the job ended (see JobOutcome). */
  outcome?: JobOutcome | string | null;
}

export type JobEvent = JobStepEvent | JobStatusEvent;

export interface StreamJobEventsOptions {
  /** Only yield steps with n > after. Default 0 (from the start). */
  after?: number;
  /** Seconds each long-poll request may be held open (server max 30). Default 25. */
  wait?: number;
  /** Stop early. Checked before each request and each yielded event, so an
   * in-flight long-poll still finishes (up to `wait` seconds). Breaking out
   * of the `for await` loop also stops it. */
  signal?: AbortSignal;
}

export interface ErrorEnvelope {
  code?: string;
  error?: string;
  message?: string;
  request_id?: string;
}

export class BrowsaError extends Error {
  code?: string;
  requestId?: string;
  status?: number;
  body?: unknown;
  constructor(message: string, opts: { code?: string; requestId?: string; status?: number; body?: unknown } = {}) {
    super(message);
    this.name = "BrowsaError";
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.status = opts.status;
    this.body = opts.body;
  }
}
/** @deprecated Renamed to BrowsaError. Kept as an alias for backwards compat; will be removed in a future major. */
export class APIError extends BrowsaError { constructor(...a: ConstructorParameters<typeof BrowsaError>) { super(...a); this.name = "APIError"; } }
export class AuthError extends BrowsaError { constructor(...a: ConstructorParameters<typeof BrowsaError>) { super(...a); this.name = "AuthError"; } }
export class RateLimitError extends BrowsaError {
  retryAfter?: number;
  constructor(msg: string, opts: ConstructorParameters<typeof BrowsaError>[1] & { retryAfter?: number } = {}) {
    super(msg, opts);
    this.name = "RateLimitError";
    this.retryAfter = opts.retryAfter;
  }
}
export class InvalidIDError extends BrowsaError { constructor(...a: ConstructorParameters<typeof BrowsaError>) { super(...a); this.name = "InvalidIDError"; } }
export class NotFoundError extends BrowsaError { constructor(...a: ConstructorParameters<typeof BrowsaError>) { super(...a); this.name = "NotFoundError"; } }
export class TimeoutError extends BrowsaError { constructor(...a: ConstructorParameters<typeof BrowsaError>) { super(...a); this.name = "TimeoutError"; } }

const DEFAULT_BASE_URL = "https://browsa.io";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_POLL_MS = 2000;
export const VERSION = "0.3.0";
const USER_AGENT = `browsa-ts/${VERSION}`;

// Convert the TOP-LEVEL keys of a request body from camelCase to the
// snake_case the API expects (e.g. llmApiKey -> llm_api_key, maxChars ->
// max_chars). Idempotent for already-snake keys. Values are left untouched,
// so a user-supplied `schema` (with arbitrary property names) is preserved.
// Without this, idiomatic camelCase options spread into the body were sent
// verbatim and silently ignored by the server (e.g. extract returned no
// `data` because llmApiKey never reached it).
function snakeCaseTopLevelKeys(body: unknown): unknown {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())] = v;
  }
  return out;
}

/** Builds the snake_case task body shared by createTask + createSchedule.
 * request() snake-cases any remaining camelCase keys + drops undefined, so
 * omitting llmApiKey (e.g. with llm:"browsa") sends no key. */
function buildTaskBody(opts: CreateTaskOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    task: opts.task,
    llm: opts.llm,
    llm_api_key: opts.llmApiKey,
    framework: opts.framework ?? "browser-use",
  };
  const map: Record<string, string> = {
    llmKeyId: "llm_key_id",
    llmBaseUrl: "llm_base_url",
    country: "country",
    osType: "os_type",
    maxSteps: "max_steps",
    reasoning: "reasoning",
    maxCredits: "max_credits",
    ja3Profile: "ja3_profile",
    initialUrl: "initial_url",
    profileId: "profile_id",
    webhookUrl: "webhook_url",
    secrets: "secrets",
    keepBrowser: "keep_browser",
    browserTtlSeconds: "browser_ttl_seconds",
    proxy: "proxy",
    proxyId: "proxy_id",
  };
  for (const [src, dst] of Object.entries(map)) {
    const v = (opts as any)[src];
    if (v != null) body[dst] = v;
  }
  for (const [k, v] of Object.entries(opts)) {
    if (["task", "llm", "llmApiKey", "framework", ...Object.keys(map)].includes(k)) continue;
    if (v != null) body[k] = v;
  }
  return body;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function snakeToUsage(u: unknown): Usage | undefined {
  if (u == null || typeof u !== "object" || Array.isArray(u)) return undefined;
  const r = u as Record<string, unknown>;
  return {
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheWriteTokens: num(r.cache_write_tokens),
    requests: num(r.requests),
  };
}

function snakeToModels(body: Record<string, any>): Models {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const own = (b.own_key && typeof b.own_key === "object" ? b.own_key : {}) as Record<string, any>;
  return {
    hosted: (Array.isArray(b.hosted) ? b.hosted : []).map((h: any) => ({
      id: h?.id || "",
      model: h?.model || "",
      fallbackModels: Array.isArray(h?.fallback_models) ? h.fallback_models : [],
      reasoning: typeof h?.reasoning === "string" ? h.reasoning : null,
      creditsPerTask: typeof h?.credits_per_task === "number" ? h.credits_per_task : undefined,
      default: !!h?.default,
    })),
    ownKey: {
      providers: Array.isArray(own.providers) ? own.providers : [],
      defaultModels: own.default_models && typeof own.default_models === "object" ? own.default_models : {},
    },
    raw: b,
  };
}

function snakeToJob(body: Record<string, any>): Job {
  const result = (body.result && typeof body.result === "object" ? body.result : {}) as Record<string, any>;
  return {
    id: body.id || body.job_id || "",
    status: body.status as JobStatus,
    kind: body.kind || "",
    stepCount: Number(body.step_count || 0),
    progressDone: Number(body.progress_done || 0),
    progressTotal: Number(body.progress_total || 0),
    framework: body.framework,
    liveUrl: body.live_url,
    agentId: body.agent_id,
    createdAt: body.created_at,
    startedAt: body.started_at,
    completedAt: body.completed_at,
    errorMessage: body.error_message,
    errorCode: body.error_code,
    creditsCharged: body.credits_charged,
    finalResult: typeof result?.final_result === "string" ? result.final_result : undefined,
    inputQuestion: body.input_question,
    resultUrl: body.result_url,
    statusUrl: body.status_url,
    files: Array.isArray(result?.files)
      ? result.files.map((f: any) => ({ name: f.name, size: f.size, createdAt: f.created_at }))
      : undefined,
    secretNames: Array.isArray(body.secret_names) ? body.secret_names : undefined,
    task: typeof body.task === "string" ? body.task : undefined,
    sessionId: body.session_id,
    sessionUrl: body.session_url,
    turn: typeof body.turn === "number" ? body.turn : undefined,
    llmKeyId: body.llm_key_id ?? undefined,
    llmKeyMasked: body.llm_key_masked ?? undefined,
    llmKeySource: body.llm_key_source ?? undefined,
    outcome: typeof body.outcome === "string" ? body.outcome : undefined,
    outcomeMessage: typeof body.outcome_message === "string" ? body.outcome_message : undefined,
    signals: Array.isArray(body.signals) ? body.signals : [],
    durationMs: typeof body.duration_ms === "number" ? body.duration_ms : undefined,
    usage: snakeToUsage(result.usage),
    llmCostUsd: typeof result.llm_cost_usd === "number" ? result.llm_cost_usd
      : result.llm_cost_usd === null ? null : undefined,
    llmTier: typeof result.llm_tier === "string" && result.llm_tier ? result.llm_tier : undefined,
    reasoning: typeof result.reasoning === "string" && result.reasoning ? result.reasoning : undefined,
    proxyNetwork: typeof body.proxy_network === "string" && body.proxy_network ? body.proxy_network : null,
    proxyBytes: Number(body.proxy_bytes || 0),
    proxyCredits: Number(body.proxy_credits || 0),
    raw: body,
  };
}

function snakeToProxyNetwork(body: Record<string, any> | null | undefined): ProxyNetwork {
  const tiers = body && Array.isArray(body.tiers) ? body.tiers : [];
  return {
    enabled: !!body && body.enabled === true,
    tiers: tiers.filter((t: any) => t && typeof t === "object").map((t: any) => ({
      network: String(t.network || ""),
      creditsPerGb: typeof t.credits_per_gb === "number" ? t.credits_per_gb : undefined,
      mbPerCredit: typeof t.mb_per_credit === "number" ? t.mb_per_credit : undefined,
      countries: Array.isArray(t.countries) ? t.countries.map(String) : [],
    })),
    raw: (body || {}) as Record<string, unknown>,
  };
}

function snakeToSession(body: Record<string, any>): Session {
  const b = (body.browser || {}) as Record<string, any>;
  return {
    id: body.id || "",
    title: body.title || "",
    status: body.status as SessionStatus,
    acceptsMessages: !!body.accepts_messages,
    closedReason: body.closed_reason,
    keepBrowser: !!body.keep_browser,
    agentId: body.agent_id,
    browser: {
      status: b.status,
      mode: b.mode,
      liveUrl: b.live_url,
      expiresAt: b.expires_at,
      expiresInSeconds: b.expires_in_seconds,
      credits: Number(b.credits || 0),
    },
    creditsCharged: Number(body.credits_charged || 0),
    turnCount: Number(body.turn_count || 0),
    turns: (Array.isArray(body.turns) ? body.turns : []).map((t: any) => ({
      jobId: t.job_id || "",
      task: t.task || "",
      status: t.status as JobStatus,
      finalResult: typeof t.final_result === "string" ? t.final_result : null,
      errorCode: t.error_code,
      errorMessage: t.error_message,
      stepCount: Number(t.step_count || 0),
      durationSeconds: typeof t.duration_seconds === "number" ? t.duration_seconds : null,
      creditsCharged: Number(t.credits_charged || 0),
      llm: t.llm,
      liveUrl: t.live_url,
      createdAt: t.created_at,
      startedAt: t.started_at,
      completedAt: t.completed_at,
    })),
    createdAt: body.created_at,
    raw: body,
  };
}

function snakeToSchedule(body: Record<string, any>): Schedule {
  return {
    id: body.id || "",
    name: body.name,
    task: body.task,
    llm: body.llm,
    intervalSeconds: Number(body.interval_seconds || 0),
    enabled: !!body.enabled,
    nextRunAt: body.next_run_at,
    lastRunAt: body.last_run_at,
    lastJobId: body.last_job_id,
    runCount: Number(body.run_count || 0),
    createdAt: body.created_at,
    llmKeyId: body.llm_key_id ?? undefined,
    reasoning: typeof body.reasoning === "string" && body.reasoning ? body.reasoning : undefined,
    raw: body,
  };
}

function snakeToLLMKey(body: Record<string, any>): LLMKey {
  return {
    id: body.id || "",
    name: body.name || "",
    provider: body.provider || "",
    masked: body.masked || "",
    baseUrl: body.base_url ?? null,
    isDefault: !!body.is_default,
    status: body.status || "",
    statusDetail: body.status_detail,
    statusMessage: body.status_message,
    lastValidatedAt: body.last_validated_at ?? null,
    lastUsedAt: body.last_used_at ?? null,
    createdAt: body.created_at,
    updatedAt: body.updated_at,
    raw: body,
  };
}

const llmKeyPath = (id: string) => `/v1/llm-keys/${encodeURIComponent(id)}`;

function snakeToWebhook(body: Record<string, any>): Webhook {
  return {
    id: body.id || "",
    url: body.url || "",
    events: body.events || [],
    createdAt: body.created_at,
    lastSentAt: body.last_sent_at,
    lastError: body.last_error,
    disabledAt: body.disabled_at,
    raw: body,
  };
}

function throwForStatus(status: number, body: ErrorEnvelope, retryAfter?: number): never {
  const code = body?.code;
  const msg = body?.error || body?.message || `HTTP ${status}`;
  const requestId = body?.request_id;
  if (status === 401 || code === "UNAUTHORIZED" || code === "INVALID_API_KEY") {
    throw new AuthError(msg, { code, requestId, status, body });
  }
  if (status === 429 || code === "RATE_LIMIT") {
    throw new RateLimitError(msg, { code, requestId, status, body, retryAfter });
  }
  if (status === 400 && code === "INVALID_ID") {
    throw new InvalidIDError(msg, { code, requestId, status, body });
  }
  if (status === 404 || code === "NOT_FOUND") {
    throw new NotFoundError(msg, { code, requestId, status, body });
  }
  throw new APIError(msg, { code, requestId, status, body });
}

export class Client {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private fetchImpl: typeof globalThis.fetch;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey || !opts.apiKey.startsWith("agt_")) {
      throw new Error("apiKey must start with 'agt_'. Mint one at https://app.browsa.io/dashboard/keys");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.fetchImpl = opts.fetch || globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("Global fetch is missing. Node 18+ required, or pass `fetch` in options.");
    }
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, unknown>; timeoutMs?: number; extraHeaders?: Record<string, string> } = {},
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url = `${url}?${s}`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.timeoutMs);
    let resp: Response;
    try {
      // Caller-provided headers (e.g. Idempotency-Key) merge in; auth
      // headers always win so a bug in the call site can't strip auth.
      const merged: Record<string, string> = {
        ...(opts.extraHeaders ?? {}),
        "X-API-Key": this.apiKey,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(opts.body != null ? { "Content-Type": "application/json" } : {}),
      };
      resp = await this.fetchImpl(url, {
        method,
        signal: ctrl.signal,
        headers: merged,
        body: opts.body != null ? JSON.stringify(snakeCaseTopLevelKeys(opts.body)) : undefined,
      });
    } catch (e: any) {
      if (e.name === "AbortError") {
        throw new TimeoutError(`request timed out after ${opts.timeoutMs ?? this.timeoutMs}ms`);
      }
      throw new BrowsaError(`network error: ${e.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }

    const ctype = resp.headers.get("content-type") || "";
    const isJson = ctype.includes("application/json");
    const rawText = await resp.text();
    let parsed: any = null;
    if (isJson && rawText) {
      try { parsed = JSON.parse(rawText); } catch { parsed = { error: rawText }; }
    }

    if (!resp.ok) {
      const ra = resp.headers.get("Retry-After");
      throwForStatus(resp.status, parsed || { error: rawText || resp.statusText }, ra ? Number(ra) : undefined);
    }
    return (parsed ?? rawText) as T;
  }

  // ── Tasks ──────────────────────────────────────────────────────────────

  /** POST /v1/tasks — submit a task; returns immediately with a job. */
  async createTask(opts: CreateTaskOptions): Promise<Job> {
    const r = await this.request<Record<string, any>>("POST", "/v1/tasks", { body: buildTaskBody(opts) });
    return snakeToJob(r);
  }

  /** GET /v1/jobs/:id. `wait` (1–120s) blocks the server response until terminal. */
  async getJob(jobId: string, opts: { wait?: number } = {}): Promise<Job> {
    const r = await this.request<Record<string, any>>("GET", `/v1/jobs/${encodeURIComponent(jobId)}`, {
      query: opts.wait ? { wait: opts.wait } : undefined,
      timeoutMs: opts.wait ? (opts.wait + 5) * 1000 : undefined,
    });
    return snakeToJob(r);
  }

  /** GET /v1/jobs/:id/status — lightweight status-only poll. */
  async getJobStatus(jobId: string): Promise<JobStatus> {
    const r = await this.request<{ status: JobStatus }>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/status`);
    return r.status;
  }

  /** POST /v1/jobs/:id/cancel — 204 on success. */
  async cancelJob(jobId: string): Promise<void> {
    await this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  /** POST /v1/jobs/:id/respond — answer an input_required prompt. */
  async respondToJob(jobId: string, response: string): Promise<Job> {
    const r = await this.request<Record<string, any>>(
      "POST",
      `/v1/jobs/${encodeURIComponent(jobId)}/respond`,
      { body: { response } },
    );
    return snakeToJob(r);
  }

  /** Block until terminal state. Uses server-side long-poll. */
  async waitForJob(jobId: string, opts: WaitOptions = {}): Promise<Job> {
    const start = Date.now();
    const poll = opts.pollMs ?? DEFAULT_POLL_MS;
    while (true) {
      const j = await this.getJob(jobId, { wait: 30 });
      try { opts.onProgress?.(j); } catch { /* never let callback break the loop */ }
      if (TERMINAL_STATUSES.includes(j.status)) return j;
      if (opts.timeoutMs != null && (Date.now() - start) > opts.timeoutMs) {
        throw new TimeoutError(`waitForJob exceeded ${opts.timeoutMs}ms — last status: ${j.status}`);
      }
      await new Promise(r => setTimeout(r, poll));
    }
  }

  /**
   * Yield a job's events as they happen, ending when the job ends.
   *
   * Long-polls `GET /v1/jobs/:id/events?after=<n>&wait=<wait>`. Yields a
   * `{type: "step", n, t, action, url, goal, result}` event for every step
   * with `n > after`, in order, then one `{type: "status", status,
   * error_code}` event when the job is completed or failed, and returns.
   *
   * To resume after a disconnect or restart, call again with `after` set to
   * the `n` of the last step you handled. Errors (network, 404, ...) are
   * thrown, not retried.
   *
   * ```ts
   * for await (const ev of client.streamJobEvents(job.id)) {
   *   if (ev.type === "step") console.log(ev.n, ev.action, ev.url);
   *   else console.log("finished:", ev.status);
   * }
   * ```
   */
  async *streamJobEvents(jobId: string, opts: StreamJobEventsOptions = {}): AsyncGenerator<JobEvent, void, undefined> {
    const wait = Math.max(0, Math.min(30, Math.floor(opts.wait ?? 25)));
    let after = Math.max(0, Math.floor(opts.after ?? 0));
    while (!opts.signal?.aborted) {
      const r = await this.request<{ events?: JobEvent[]; next_after?: number; done?: boolean }>(
        "GET",
        `/v1/jobs/${encodeURIComponent(jobId)}/events`,
        { query: { after, wait }, timeoutMs: (wait + 10) * 1000 },
      );
      for (const ev of r?.events ?? []) {
        if (opts.signal?.aborted) return;
        yield ev;
      }
      if (typeof r?.next_after === "number" && r.next_after > after) after = r.next_after;
      if (r?.done) return;
    }
  }

  /**
   * One-shot: submit + wait + return terminal job. The "hello world" entry point.
   * Accepts every createTask option, including `secrets` (the model sees only
   * the names; see CreateTaskOptions.secrets).
   */
  async runTask(opts: CreateTaskOptions & WaitOptions): Promise<Job> {
    const { timeoutMs, pollMs, onProgress, ...createOpts } = opts;
    const job = await this.createTask(createOpts);
    return this.waitForJob(job.id, { timeoutMs: timeoutMs ?? 600_000, pollMs, onProgress });
  }

  // ── Sessions (follow-up messages on the same browser) ──────────────────

  /**
   * POST /v1/tasks with keep_browser: true. Runs the first task of a session
   * and keeps its browser up afterwards, until browserTtlSeconds after it
   * launched (300 to 3600, default 900). Same price as a normal task browser
   * (5 credits). Returns the accepted job; `job.sessionId` (equal to
   * `job.id`) is what sendMessage, getSession and stopSession take. Takes
   * every createTask option, including agentId.
   */
  async createSession(opts: CreateTaskOptions): Promise<Job> {
    return this.createTask({ ...opts, keepBrowser: true });
  }

  /**
   * POST /v1/sessions/:id/messages. Queues a follow-up task on the session's
   * browser and returns the new turn's accepted job (with sessionId and
   * turn); wait on it with waitForJob(job.id), or use runMessage.
   *
   * The agent continues on the page where the last turn ended and is given
   * the previous task and its result. Model fields left out reuse the
   * previous turn's model, but a BYOK llmApiKey must be sent again on every
   * message (keys are deleted when a task ends), or use a hosted tier
   * (llm "browsa", "browsa-fast" or "browsa-smart"). A follow-up on a kept
   * burner pays no browser, only the task's base and step credits.
   * `reasoning` applies to this turn.
   *
   * Throws APIError with code BROWSER_EXPIRED (409) when the browser is gone
   * (start a new session), SESSION_BUSY (409) while a turn is still queued
   * or running, and NotFoundError for an unknown id.
   */
  async sendMessage(sessionId: string, task: string, opts: SendMessageOptions = {}): Promise<Job> {
    const { idempotencyKey, ...rest } = opts;
    const body: Record<string, unknown> = { task };
    for (const [k, v] of Object.entries(rest)) if (v != null) body[k] = v;
    const r = await this.request<Record<string, any>>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { body, extraHeaders: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined },
    );
    return snakeToJob(r);
  }

  /** sendMessage + waitForJob: returns the turn's terminal job, with sessionId and turn kept from the 202. */
  async runMessage(sessionId: string, task: string, opts: SendMessageOptions & WaitOptions = {}): Promise<Job> {
    const { timeoutMs, pollMs, onProgress, ...sendOpts } = opts;
    const job = await this.sendMessage(sessionId, task, sendOpts);
    const done = await this.waitForJob(job.id, { timeoutMs: timeoutMs ?? 600_000, pollMs, onProgress });
    return { ...done, sessionId: done.sessionId ?? job.sessionId ?? sessionId, turn: done.turn ?? job.turn };
  }

  /**
   * GET /v1/sessions/:id: the session's turns in order and its browser. Any
   * task job id works: a task run without keepBrowser comes back as a closed
   * one-turn session (closedReason "single_task").
   */
  async getSession(sessionId: string): Promise<Session> {
    const r = await this.request<Record<string, any>>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
    return snakeToSession(r);
  }

  /**
   * POST /v1/sessions/:id/stop. Cancels a turn still in progress (it keeps
   * its browser charge, like any cancel) and stops the browser (a burner is
   * destroyed; an identity session is closed and its cookies saved).
   * Idempotent. Returns the session after the stop.
   */
  async stopSession(sessionId: string): Promise<Session> {
    const r = await this.request<Record<string, any>>("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/stop`);
    return snakeToSession(r);
  }

  // ── Job files ──────────────────────────────────────────────────────────

  /** GET /v1/jobs/:id/files — list output files the agent wrote (metadata). */
  async listJobFiles(jobId: string): Promise<JobFile[]> {
    const r = await this.request<{ files?: any[] }>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/files`);
    return (r.files ?? []).map((f) => ({ name: f.name, size: f.size, createdAt: f.created_at }));
  }

  /** GET /v1/jobs/:id/files/:name — download one output file's bytes. */
  async downloadJobFile(jobId: string, name: string): Promise<Uint8Array> {
    const url = `${this.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: "GET",
        signal: ctrl.signal,
        headers: { "X-API-Key": this.apiKey, "User-Agent": USER_AGENT },
      });
    } catch (e: any) {
      if (e.name === "AbortError") throw new TimeoutError(`download timed out after ${this.timeoutMs}ms`);
      throw new BrowsaError(`network error: ${e.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    if (resp.status >= 300) {
      // Errors use the same {code, error, request_id} envelope as every
      // other endpoint; parse it so e.code and e.requestId are set.
      const t = await resp.text().catch(() => "");
      let env: ErrorEnvelope = { error: t || resp.statusText };
      try {
        const j = JSON.parse(t);
        if (j && typeof j === "object") env = j;
      } catch { /* not JSON: keep the raw text */ }
      const ra = resp.headers.get("Retry-After");
      throwForStatus(resp.status, env, ra ? Number(ra) : undefined);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  // ── Scheduled tasks ────────────────────────────────────────────────────

  /**
   * POST /v1/schedules: create a recurring task (interval 3600 to 2592000s).
   * Pass llmKeyId to run with a saved key (the schedule stores only the id,
   * so a rotated key is picked up by the next run), or omit llmApiKey and
   * llmKeyId to use the workspace's default saved key.
   */
  async createSchedule(opts: CreateScheduleOptions): Promise<Schedule> {
    const r = await this.request<Record<string, any>>("POST", "/v1/schedules", { body: buildTaskBody(opts) });
    return snakeToSchedule(r);
  }

  /** GET /v1/schedules — list this workspace's schedules (secrets redacted). */
  async listSchedules(): Promise<Schedule[]> {
    const r = await this.request<{ schedules?: any[] }>("GET", "/v1/schedules");
    return (r.schedules ?? []).map(snakeToSchedule);
  }

  /** GET /v1/schedules/:id. */
  async getSchedule(id: string): Promise<Schedule> {
    const r = await this.request<Record<string, any>>("GET", `/v1/schedules/${encodeURIComponent(id)}`);
    return snakeToSchedule(r);
  }

  /** PATCH /v1/schedules/:id — pause (false) or resume (true). */
  async setScheduleEnabled(id: string, enabled: boolean): Promise<Schedule> {
    const r = await this.request<Record<string, any>>("PATCH", `/v1/schedules/${encodeURIComponent(id)}`, { body: { enabled } });
    return snakeToSchedule(r);
  }

  /** DELETE /v1/schedules/:id. */
  async deleteSchedule(id: string): Promise<void> {
    await this.request("DELETE", `/v1/schedules/${encodeURIComponent(id)}`);
  }

  // ── Webhooks ───────────────────────────────────────────────────────────

  async listWebhooks(): Promise<Webhook[]> {
    const r = await this.request<{ webhooks?: any[] }>("GET", "/v1/webhooks");
    return (r.webhooks || []).map(snakeToWebhook);
  }

  async createWebhook(opts: { url: string; events?: string[] }): Promise<Webhook> {
    const r = await this.request<Record<string, any>>("POST", "/v1/webhooks", { body: opts });
    return snakeToWebhook(r);
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request("DELETE", `/v1/webhooks/${encodeURIComponent(webhookId)}`);
  }

  async testWebhook(webhookId: string): Promise<Record<string, any>> {
    return this.request("POST", `/v1/webhooks/${encodeURIComponent(webhookId)}/test`);
  }

  /**
   * GET /v1/webhooks/:id/deliveries: the latest delivery attempts, newest
   * first (limit 1 to 200, default 50). Each row: id, event_id, event_type,
   * status_code, delivered_at, duration_ms, error, attempt, response_body.
   * Use it to see why a receiver missed an event.
   */
  async listWebhookDeliveries(webhookId: string, opts: { limit?: number } = {}): Promise<Array<Record<string, any>>> {
    const r = await this.request<{ deliveries?: any[] }>(
      "GET", `/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries`, { query: { limit: opts.limit } });
    return r?.deliveries ?? [];
  }

  async getSigningSecret(): Promise<string> {
    const r = await this.request<{ secret: string }>("GET", "/v1/webhooks/signing-secret");
    return r.secret;
  }

  // ── Saved LLM keys ─────────────────────────────────────────────────────
  // The API never returns a saved secret, only `masked` (prefix + last 4).
  // apiKey is sent once in the request body and never kept on the client.

  /**
   * POST /v1/llm-keys: save an LLM provider key for this workspace. The key
   * is checked first with a free model-list call; an invalid key throws
   * APIError with code LLM_KEY_INVALID (status 422) and nothing is saved.
   * Up to 20 keys per workspace (409 LLM_KEY_LIMIT).
   */
  async createLlmKey(opts: CreateLLMKeyOptions): Promise<LLMKey> {
    const body: Record<string, unknown> = { provider: opts.provider, api_key: opts.apiKey };
    if (opts.name != null) body.name = opts.name;
    if (opts.baseUrl != null) body.base_url = opts.baseUrl;
    if (opts.default != null) body.default = opts.default;
    return snakeToLLMKey(await this.request<Record<string, any>>("POST", "/v1/llm-keys", { body }));
  }

  /** GET /v1/llm-keys: this workspace's saved LLM keys, newest first. */
  async listLlmKeys(): Promise<LLMKey[]> {
    const r = await this.request<{ llm_keys?: any[] }>("GET", "/v1/llm-keys");
    return (r?.llm_keys ?? []).map(snakeToLLMKey);
  }

  /** GET /v1/llm-keys/:id. */
  async getLlmKey(id: string): Promise<LLMKey> {
    return snakeToLLMKey(await this.request<Record<string, any>>("GET", llmKeyPath(id)));
  }

  /** POST /v1/llm-keys/:id/validate: check the key again; returns its fresh status. */
  async validateLlmKey(id: string): Promise<LLMKey> {
    return snakeToLLMKey(await this.request<Record<string, any>>("POST", `${llmKeyPath(id)}/validate`));
  }

  /**
   * POST /v1/llm-keys/:id/rotate: replace the secret, keeping the id. The
   * new key is validated first; on 422 LLM_KEY_INVALID the old secret stays.
   * Queued and scheduled runs pick up the new secret.
   */
  async rotateLlmKey(id: string, opts: RotateLLMKeyOptions): Promise<LLMKey> {
    const body: Record<string, unknown> = { api_key: opts.apiKey };
    if (opts.baseUrl != null) body.base_url = opts.baseUrl;
    return snakeToLLMKey(await this.request<Record<string, any>>("POST", `${llmKeyPath(id)}/rotate`, { body }));
  }

  /** POST /v1/llm-keys/:id: rename it, or set (true) or remove (false) its default flag. */
  async updateLlmKey(id: string, opts: UpdateLLMKeyOptions): Promise<LLMKey> {
    const body: Record<string, unknown> = {};
    if (opts.name != null) body.name = opts.name;
    if (opts.default != null) body.default = opts.default;
    if (Object.keys(body).length === 0) throw new Error("updateLlmKey needs name or default");
    return snakeToLLMKey(await this.request<Record<string, any>>("POST", llmKeyPath(id), { body }));
  }

  /**
   * DELETE /v1/llm-keys/:id: delete the key and its encrypted value. Queued
   * or scheduled runs that use it fail with LLM_KEY_MISSING.
   */
  async deleteLlmKey(id: string): Promise<void> {
    await this.request("DELETE", llmKeyPath(id));
  }

  // ── Models ─────────────────────────────────────────────────────────────

  /**
   * GET /v1/models: the hosted tiers (id, the model each runs on, its
   * fallbacks, default reasoning and creditsPerTask) and the providers you
   * can bring your own key for. Read-only and free. The models and credit
   * numbers are server settings and can change, so read them here instead
   * of hardcoding them.
   */
  async models(): Promise<Models> {
    return snakeToModels(await this.request<Record<string, any>>("GET", "/v1/models"));
  }

  // ── Keys / Credits / Team / Identities ─────────────────────────────────

  async listKeys(): Promise<Array<Record<string, any>>> {
    const r = await this.request<{ keys?: any[] }>("GET", "/v1/keys");
    return r.keys || [];
  }

  async credits(): Promise<Record<string, any>> {
    return this.request("GET", "/v1/credits");
  }

  /**
   * GET /v1/proxy-network: the built-in proxy network of this server.
   * `enabled` says whether `proxy: { network }` can be used at all; `tiers`
   * lists each network with its `countries` and its price (`creditsPerGb`,
   * `mbPerCredit`). An API that does not have the endpoint yet (404) reads
   * as not enabled.
   */
  async proxyNetwork(): Promise<ProxyNetwork> {
    try {
      return snakeToProxyNetwork(await this.request<Record<string, any>>("GET", "/v1/proxy-network"));
    } catch (e) {
      if (e instanceof NotFoundError) return snakeToProxyNetwork(null);
      throw e;
    }
  }

  /**
   * GET /v1/credits/ledger?limit=N — per-job credit-ledger entries.
   * Returns `{balance, count, entries: [...]}`. Every job-completion writes
   * one debit row tagged with the linked job id; signup bonuses, refunds,
   * and Stripe top-ups write positive rows.
   */
  async listLedger(opts: { limit?: number } = {}): Promise<Record<string, any>> {
    return this.request("GET", "/v1/credits/ledger", { query: { limit: opts.limit ?? 50 } });
  }

  // ── Quick endpoints (sync or async=true) ─────────────────────────────
  // No-LLM-required scrape primitives. Pass { async: true } for
  // fire-and-poll (returns a Job envelope); without, the server blocks
  // until done.

  async scrape(url: string, opts: { async?: boolean; idempotencyKey?: string; [k: string]: any } = {}): Promise<Record<string, any>> {
    const { async: isAsync, idempotencyKey, ...rest } = opts;
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return this.request("POST", "/v1/quick/scrape" + (isAsync ? "?async=true" : ""), {
      body: { url, ...rest },
      timeoutMs: 120_000,
      extraHeaders: headers,
    });
  }

  async extract(url: string, opts: { schema?: unknown; prompt?: string; async?: boolean; idempotencyKey?: string; [k: string]: any } = {}): Promise<Record<string, any>> {
    const { async: isAsync, idempotencyKey, ...rest } = opts;
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return this.request("POST", "/v1/quick/extract" + (isAsync ? "?async=true" : ""), {
      body: { url, ...rest },
      timeoutMs: 180_000,
      extraHeaders: headers,
    });
  }

  async screenshot(url: string, opts: { fullPage?: boolean; async?: boolean; idempotencyKey?: string; [k: string]: any } = {}): Promise<Record<string, any>> {
    const { async: isAsync, fullPage, idempotencyKey, ...rest } = opts;
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return this.request("POST", "/v1/quick/screenshot" + (isAsync ? "?async=true" : ""), {
      body: { url, full_page: fullPage ?? true, ...rest },
      timeoutMs: 60_000,
      extraHeaders: headers,
    });
  }

  /**
   * POST /v1/quick/batch: scrape up to 100 URLs (4 at a time) as one job.
   * Always asynchronous: returns the 202 job envelope (`job_id`); wait with
   * waitForJob(job_id). Batch only scrapes: for extract or screenshot, call
   * extract()/screenshot() per URL. Takes the scrape options (formats,
   * maxChars, waitMs, country, block).
   */
  async batch(urls: string[], opts: { mode?: "scrape"; async?: boolean; [k: string]: any } = {}): Promise<Record<string, any>> {
    const { async: _isAsync, mode, ...rest } = opts;
    if (mode != null && mode !== "scrape") {
      throw new Error(`batch only scrapes (got mode "${mode}"); call ${mode}() per URL instead`);
    }
    return this.request("POST", "/v1/quick/batch", { body: { urls, ...rest }, timeoutMs: 300_000 });
  }

  async crawl(startUrl: string, opts: { maxPages?: number; async?: boolean; [k: string]: any } = {}): Promise<Record<string, any>> {
    const { async: isAsync, maxPages, ...rest } = opts;
    return this.request("POST", "/v1/quick/crawl" + (isAsync === false ? "" : "?async=true"), {
      body: { start_url: startUrl, max_pages: maxPages ?? 25, ...rest },
      timeoutMs: 300_000,
    });
  }

  // ── Agents (burner + persistent) ─────────────────────────────────────

  /**
   * POST /v1/agents — provision an agent.
   *
   * Fingerprint overrides (power-user — leave empty for platform defaults):
   *   screenResolution: "1366x768" | "1920x1080" | "2560x1440" |
   *                     "3840x2160" | "mobile-iphone" |
   *                     "mobile-android-pixel" | "WxH" custom
   *   webrtcMode:        "masked" | "real" | "disabled"
   *   geolocationMode:   "prompt" | "allow" | "block"
   *   geolocationData:   "lat,lng" (when geolocationMode="allow")
   *   mediaDevicesMode:  "masked" | "real"
   *   portScanProtection:"masked" | "real"
   * Mismatched combinations (e.g. mobile resolution + osType=OS_TYPE_MACOS)
   * surface in the fingerprint preview's `warnings` array and may lower
   * the agent's trust score.
   *
   * proxy: your own proxy, or a tier of Browsa's built-in network
   * (`{ network: "datacenter", country: "us" }`, only when proxyNetwork()
   * reports enabled). proxyId: a saved proxy instead. With the built-in
   * network the response also has `proxy_network`, `proxy_bytes` and
   * `proxy_credits`.
   */
  async createAgent(opts: {
    ttl?: string; country?: string; persona?: string;
    osType?: string; ja3Profile?: string;
    screenResolution?: string; webrtcMode?: string;
    geolocationMode?: string; geolocationData?: string;
    mediaDevicesMode?: string; portScanProtection?: string;
    proxy?: Proxy; proxyId?: string;
    [k: string]: any;
  } = {}): Promise<Record<string, any>> {
    const body: Record<string, any> = {};
    const map: Record<string, string> = {
      ttl: "ttl", country: "country", persona: "persona",
      osType: "os_type", ja3Profile: "ja3_profile",
      screenResolution: "screen_resolution",
      webrtcMode: "webrtc_mode",
      geolocationMode: "geolocation_mode",
      geolocationData: "geolocation_data",
      mediaDevicesMode: "media_devices_mode",
      portScanProtection: "port_scan_protection",
      proxy: "proxy",
      proxyId: "proxy_id",
    };
    for (const [src, dst] of Object.entries(map)) {
      const v = (opts as any)[src];
      if (v != null) body[dst] = v;
    }
    for (const [k, v] of Object.entries(opts)) {
      if (Object.keys(map).includes(k)) continue;
      if (v != null) body[k] = v;
    }
    return this.request("POST", "/v1/agents", { body });
  }

  async getAgent(agentId: string): Promise<Record<string, any>> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}`);
  }

  async destroyAgent(agentId: string): Promise<void> {
    await this.request("DELETE", `/v1/agents/${encodeURIComponent(agentId)}`);
  }

  /**
   * GET /v1/agents/{id}/cdp: returns `cdp_url`, the page-level CDP
   * WebSocket of a running agent (it needs auth). Note: this endpoint (and
   * getAgent) give it with a placeholder page id (".../ws/page/..."); only
   * createAgent returns the real page URL. To attach Playwright or
   * Puppeteer, use the agent's `cdp_http` with an `X-API-Key` header, e.g.
   * `chromium.connectOverCDP(agent.cdp_http, { headers: { "X-API-Key": apiKey } })`.
   */
  async getCdpUrl(agentId: string): Promise<string> {
    const r = await this.request<{ cdp_url?: string }>("GET", `/v1/agents/${encodeURIComponent(agentId)}/cdp`);
    return r.cdp_url ?? "";
  }

  async openSession(agentId: string, opts: { ttl?: string } = {}): Promise<Record<string, any>> {
    const body: Record<string, any> = {};
    if (opts.ttl != null) body.ttl = opts.ttl;
    return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/sessions`, { body });
  }

  /**
   * GET /v1/agents/{id}/fingerprint — wire-level fingerprint preview
   * (navigator, screen, webgl, timezone, canvas, audio, tls). Use this
   * to validate an identity against your own anti-fingerprint test
   * suite before running a task.
   */
  async fingerprint(agentId: string): Promise<Record<string, any>> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}/fingerprint`);
  }

  /**
   * GET /v1/agents/{id}/trust — per-factor trust score breakdown so you
   * can see WHY a given identity scored what it did and which knob to
   * turn (warmup_recipe, persistent mode, etc.) to raise it.
   */
  async trustBreakdown(agentId: string): Promise<Record<string, any>> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}/trust`);
  }

  /**
   * GET /v1/agents/{id}/detection-signal — most-recent detection-harness
   * verdict for this identity's fingerprint shape. Returns `{ signal: null }`
   * when no recent harness data is available; otherwise carries
   * sites_tested + sites_passed + per-site verdicts. The empirical
   * proof behind the trust score number.
   */
  async detectionSignal(agentId: string): Promise<Record<string, any>> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}/detection-signal`);
  }

  /**
   * POST /v1/auto — smart-router. Same body as createTask but the
   * platform inspects the task wording:
   *  - fetch-only tasks ("go to URL, return text/h1/json", no
   *    clicks/types) short-circuit to /v1/quick/scrape (~5s response).
   *  - interactive tasks fall through to a regular task (job_id).
   *
   * Response carries `routed_via: "scrape" | "task"` for client branching.
   */
  async auto(task: string, opts: {
    llm?: string; llmApiKey?: string; llmKeyId?: string; llmBaseUrl?: string;
    maxSteps?: number; maxCostUsd?: number; maxCredits?: number; country?: string;
    reasoning?: Reasoning;
    [k: string]: any;
  } = {}): Promise<Record<string, any>> {
    const { llm, llmApiKey, llmKeyId, llmBaseUrl, maxSteps, maxCostUsd, maxCredits, country, ...rest } = opts;
    const body: Record<string, any> = { task, ...rest };
    if (llm) body.llm = llm;
    if (llmApiKey) body.llm_api_key = llmApiKey;
    if (llmKeyId) body.llm_key_id = llmKeyId;
    if (llmBaseUrl) body.llm_base_url = llmBaseUrl;
    if (maxSteps) body.max_steps = maxSteps;
    if (maxCostUsd) body.max_cost_usd = maxCostUsd;
    if (maxCredits != null) body.max_credits = maxCredits;
    if (country) body.country = country;
    return this.request("POST", "/v1/auto", { body, timeoutMs: 120_000 });
  }

  /**
   * Convenience helper — returns a ready-to-paste connect snippet for
   * the given client framework. Competitor-audit 2026-06-09 P0:
   * browser-use cloud forces devs to hand-write the connect boilerplate
   * every time. One SDK call here instead.
   *
   * @param framework one of "playwright_py", "playwright_ts", "puppeteer_js", "curl"
   */
  async connect(agentId: string, opts: { framework?: "playwright_py" | "playwright_ts" | "puppeteer_js" | "curl" } = {}):
    Promise<{ framework: string; cdp_http: string; cdp_url: string; snippet: string }>
  {
    const framework = opts.framework ?? "playwright_ts";
    const agent = await this.getAgent(agentId);
    const profileId = (agent.profile_id as string) ?? "";
    const cdpHttp = (agent.cdp_http as string) ?? (profileId ? `https://browsa.io/api/v1/cdp/${profileId}` : "");
    const cdpUrl  = (agent.cdp_url  as string) ?? (profileId ? `wss://browsa.io/api/v1/cdp/${profileId}/ws/page/...` : "");
    if (!cdpHttp) throw new Error(`agent ${agentId} has no CDP URL — is it status=running? current status: ${agent.status ?? "unknown"}`);
    const snippets: Record<string, string> = {
      playwright_py: `import asyncio
import os
from playwright.async_api import async_playwright

CDP_URL = "${cdpHttp}"
API_KEY = os.environ["BROWSA_API_KEY"]

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(CDP_URL, headers={"X-API-Key": API_KEY})
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto("https://example.com")
        print(await page.title())
        await browser.close()

asyncio.run(main())
`,
      playwright_ts: `import { chromium } from "playwright";

const CDP_URL = "${cdpHttp}";
const API_KEY = process.env.BROWSA_API_KEY!;

const browser = await chromium.connectOverCDP(CDP_URL, { headers: { "X-API-Key": API_KEY } });
const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
`,
      puppeteer_js: `import puppeteer from "puppeteer";

const CDP_URL = "${cdpHttp}";
const API_KEY = process.env.BROWSA_API_KEY;

const browser = await puppeteer.connect({ browserURL: CDP_URL, headers: { "X-API-Key": API_KEY } });
const page = await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.disconnect();
`,
      curl: `# CDP HTTP endpoint (Playwright/Puppeteer call this for /json/version):
curl -H "X-API-Key: ${this.apiKey.slice(0, 14)}..." ${cdpHttp}/json/version

# Page-level CDP WebSocket (needs auth; for raw CDP clients, not Playwright/Puppeteer):
# ${cdpUrl}
`,
    };
    if (!(framework in snippets)) {
      throw new Error(`unknown framework "${framework}" — choose from ${Object.keys(snippets).join(", ")}`);
    }
    return { framework, cdp_http: cdpHttp, cdp_url: cdpUrl, snippet: snippets[framework] };
  }

  // ── API keys ──────────────────────────────────────────────────────────

  async mintKey(opts: { name: string }): Promise<Record<string, any>> {
    return this.request("POST", "/v1/keys", { body: { name: opts.name } });
  }

  async revokeKey(keyId: string): Promise<void> {
    await this.request("DELETE", `/v1/keys/${encodeURIComponent(keyId)}`);
  }

  /**
   * PUT /v1/keys/:id/budget — set this key's monthly spending limit in
   * credits (1 to 1000000), or `null` to remove it. Once the key's spend
   * this UTC month plus a new action's cost would go over it, new browsers,
   * sessions and tasks started with the key get 402 KEY_BUDGET_REACHED;
   * work already running may finish. listKeys() rows carry
   * monthly_budget_credits and spent_this_month.
   */
  async setKeyBudget(keyId: string, monthlyBudgetCredits: number | null): Promise<{
    id: string; monthly_budget_credits: number | null; spent_this_month: number; resets_at: string;
  }> {
    return this.request("PUT", `/v1/keys/${encodeURIComponent(keyId)}/budget`, {
      body: { monthly_budget_credits: monthlyBudgetCredits },
    });
  }

  async listTeam(): Promise<Record<string, any>> {
    return this.request("GET", "/v1/team/members");
  }

  async listIdentities(): Promise<Array<Record<string, any>>> {
    const r = await this.request<{ agents?: any[] }>("GET", "/v1/agents");
    return r.agents || [];
  }
}

