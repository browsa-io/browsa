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
 *         llm: "browsa",
 *     });
 *     console.log(job.outcome, job.finalResult);
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
  /** True when the task was created with recordRecipe. */
  recordRecipe?: boolean;
  /** The recipe draft recorded from this run (recordRecipe), null until it is stored. */
  recipeDraftId?: string | null;
  /**
   * Workspace secrets (secretIds) the job was given, value-free: id, name,
   * type, origins, description, placeholders. Unset when none.
   */
  secretsUsed?: Array<Record<string, unknown>>;
  /**
   * Logins the run created (a signup) and saved as workspace secrets, from
   * the job's result. Empty when none. See CreateTaskOptions.saveSecrets.
   */
  savedSecrets: SavedSecret[];
  /** Why a login the run created was not saved. Unset when nothing was refused. */
  secretsNotSaved?: SecretsNotSaved;
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
  | "captcha_solved"
  | "proxy_failed"
  | "navigation_failed"
  | "llm_error"
  | "llm_fallback_used"
  | "human_input_requested"
  | "captcha_handoff"
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
  /** Workspace secrets this turn may type, as `secrets.NAME` in the task. See CreateTaskOptions.secretIds. */
  secretIds?: string[];
  /** false: do not save a login this turn creates. See CreateTaskOptions.saveSecrets. */
  saveSecrets?: boolean;
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
  /**
   * Record the run as a recipe draft (replays). When the task has finished,
   * the job has recipeDraftId; createRecipe({ fromJobId }) turns it into a
   * recipe you can run with runRecipe.
   */
  recordRecipe?: boolean;
  /**
   * Workspace secrets (client.secrets) the task may type, by name or id, at
   * most 20. Refer to them in the task text as `secrets.NAME`,
   * `secrets.NAME.username`, `secrets.NAME.password` or `secrets.NAME.totp`
   * (a one-time code), e.g. "log in with secrets.GITHUB_LOGIN". Attachment
   * is explicit: a reference to a secret not listed here is 400
   * SECRET_NOT_ATTACHED, an unknown name 400 SECRET_NOT_FOUND. The older
   * `{{secret:NAME}}` and `%NAME%` forms still work.
   */
  secretIds?: string[];
  /**
   * When the run creates a login (a signup), the runner saves it as a
   * workspace secret and the finished job lists it in `savedSecrets` (or
   * says why not in `secretsNotSaved`). On by default on the server; pass
   * false to opt out. Sent only when set.
   */
  saveSecrets?: boolean;
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

export { BrowsaError, APIError, AuthError, RateLimitError, InvalidIDError, NotFoundError, TimeoutError } from "./errors";
export type { ErrorEnvelope } from "./errors";
export {
  CaptchaClient, CaptchaError, CaptchaTimeoutError, captchaTasks, normalizeCaptchaTask, captchaProxyString,
  TwoCaptchaSolver, useWithAntiCaptcha, DEFAULT_CAPTCHA_URL, CAPTCHA_TASK_TYPES,
} from "./captcha";
export type {
  CaptchaClientOptions, CaptchaAnswer, CaptchaTask, CaptchaTaskType, RecognitionTaskType, TokenTaskType, CaptchaProxy,
  Solved, TokenSolution, TurnstileSolution, TextSolution, GridSolution, AwsWafSolution, SliderSolution, TwoCaptchaAnswer,
} from "./captcha";
import { BrowsaError, APIError, AuthError, RateLimitError, InvalidIDError, NotFoundError, TimeoutError } from "./errors";
import type { ErrorEnvelope } from "./errors";

const DEFAULT_BASE_URL = "https://browsa.io";
/** Browser connections (CDP over WebSocket) have a host of their own that no
 *  CDN sits in front of. The API's cdp_http / cdp_url always win; this is
 *  only the fallback connect() builds when an agent carries no CDP address.
 *  wss://browsa.io/api/v1/cdp/... keeps working. */
const DEFAULT_CDP_BASE_URL = "https://cdp.browsa.io";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_POLL_MS = 2000;
import { VERSION } from "./version";
export { VERSION };
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
    recordRecipe: "record_recipe",
    secretIds: "secret_ids",
    saveSecrets: "save_secrets",
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
    recordRecipe: body.record_recipe === true ? true : undefined,
    recipeDraftId: typeof body.recipe_draft_id === "string" ? body.recipe_draft_id
      : body.record_recipe === true ? null : undefined,
    secretsUsed: Array.isArray(body.secrets_used)
      ? body.secrets_used.filter((s: unknown) => s && typeof s === "object") : undefined,
    savedSecrets: savedSecretsFromResult(result),
    secretsNotSaved: secretsNotSavedFromResult(result),
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

// ── Page view: observe and act without CDP ─────────────────────────────

/** One file a running browser downloaded (listDownloads()). */
export interface DownloadedFile {
  /** The site's file name, or the download id when the client asked for
   *  files named by id (Playwright does: the last part of download.path()). */
  name: string;
  /** Bytes. */
  size: number;
  modified_at?: string;
}

/** Options for createLiveLink(). */
export interface LiveLinkOptions {
  /** "view" watches only (default); "control" can click and type. */
  scope?: "view" | "control";
  /** 60 to 86400. Default: one hour. */
  ttlSeconds?: number;
  /** Tie the link to one task on this browser and show its steps. */
  jobId?: string;
}

/** A Phantom Live link (createLiveLink()). It opens once. */
export interface LiveLink {
  live_url: string;
  expires_at?: string;
  scope?: "view" | "control" | string;
  agent_id?: string;
  job_id?: string;
}

/** Options of observe(). */
export interface ObserveOptions {
  /** "viewport" (default) lists what is in the viewport and counts the rest; "page" lists the whole page. */
  scope?: "viewport" | "page";
  /** Approximate tokens (characters / 4). Default 2000; -1 for none. */
  budget?: number;
  /** Id of a container, table, list or select to list in full. */
  expand?: number;
  /** A tab id from `tabs`. Default: the tab used last. */
  tab?: string;
  /** Also return the view as a structure under `view`. */
  json?: boolean;
  /** The view session to check against. Default: the last one this client saw; "" sends none. */
  session?: string;
}

/** A tab of the browser, as observe() lists it. */
export interface PageTab {
  id: string;
  url?: string;
  title?: string;
  /** The tab the answer is about. */
  active: boolean;
}

/** What observe() returns. Keys are the API's own (snake_case). */
export interface PageView {
  /** The view for a model: one element per line, `[id] role "name"  state`. */
  text: string;
  /** "challenge": a full-page bot check, nothing is read. "dialog": a JavaScript dialog is open. */
  state: "ok" | "challenge" | "dialog";
  url: string;
  title: string;
  scope?: string;
  scroll_y?: number;
  page_h?: number;
  viewport_w?: number;
  viewport_h?: number;
  /** Approximate size of `text` (characters / 4). */
  tokens?: number;
  total?: number;
  total_interactive?: number;
  degraded?: number;
  truncated?: boolean;
  loading?: boolean;
  dialog?: Record<string, any>;
  challenge?: Record<string, any>;
  tab: string;
  tabs?: PageTab[];
  /** The view session. Ids are valid while it stays the same. */
  session: string;
  /** True when this call started a new view session: ids from earlier answers are not valid. */
  ids_reset: boolean;
  /** With `json: true`: the view as a structure. */
  view?: Record<string, any>;
}

/** One action for act(): the engine's action object. */
export interface PageAction {
  action:
    | "click" | "type" | "press" | "select" | "check" | "uncheck" | "hover" | "scroll"
    | "navigate" | "back" | "forward" | "reload" | "wait" | "upload" | "dialog";
  /** Target element, from a view. Or `role` + `name`, or `x` + `y` for a click. */
  id?: number;
  role?: string;
  name?: string;
  x?: number;
  y?: number;
  /** type: the text. wait for text: the text. dialog: the prompt answer. */
  text?: string;
  /**
   * type, instead of `text`: a workspace secret typed by reference, e.g.
   * "GITHUB_LOGIN:password" (`NAME`, `NAME:username`, `NAME:password` or
   * `TOTP:NAME`). The value never reaches you; it is typed only when the
   * page's origin is one of the secret's origins (status "secret_origin"
   * and nothing typed otherwise).
   */
  secret?: string;
  clear?: boolean;
  submit?: boolean;
  /** press: "Enter", "Control+A", "Tab Tab Enter". */
  keys?: string;
  /** select: option text or value. */
  option?: string;
  double?: boolean;
  right?: boolean;
  modifiers?: Array<"Control" | "Shift" | "Alt" | "Meta">;
  /** scroll: pixels, positive is down. */
  dy?: number;
  to?: "top" | "bottom";
  url?: string;
  /** wait: a fixed time, at most 30000. */
  ms?: number;
  for?: "text" | "id-gone" | "url-change";
  /** wait: milliseconds, default 10000, at most 30000. */
  timeout?: number;
  /** upload: paths on the browser's machine. */
  files?: string[];
  /** dialog: accept (true) or dismiss. */
  accept?: boolean;
  tab?: string;
  json?: boolean;
  session?: string;
}

/** What act() returns. Keys are the API's own (snake_case). */
export interface ActResult {
  /** What happened, for a model: the changes, how the page settled, a new view after a navigation. */
  text: string;
  /** "stale": the id is from a view the server no longer has; nothing was done, `text` carries a new view. */
  status: "ok" | "failed" | "blocked" | "challenge" | "stale" | "secret_origin" | (string & {});
  reason?: string;
  action: string;
  url?: string;
  navigation?: { url: string; same_document: boolean };
  fresh_view?: string;
  settle?: Record<string, any>;
  new_tabs?: string[];
  downloads?: string[];
  dialog?: Record<string, any>;
  challenge?: Record<string, any>;
  tab: string;
  session: string;
  ids_reset: boolean;
  /** With `json: true`: the result as a structure. */
  result?: Record<string, any>;
}

// ── Recipes (replays) ─────────────────────────────────────────────────────

/** How a repaired version is handled: "auto" promotes it once its run passed, "review" keeps it a draft until promoteRecipeVersion, "off" keeps it a draft too. */
export type RepairMode = "auto" | "review" | "off";

/** A recipe: a versioned JSON program recorded from a task run or uploaded. */
export interface Recipe {
  id: string;
  name: string;
  /** "draft" (recorded, not created yet) or "active". */
  status: "draft" | "active" | string;
  /** The version runRecipe uses; null for a draft. */
  currentVersion: number | null;
  repairMode: RepairMode | string;
  /**
   * Credits one successful run costs: the same as the job run as an agent
   * task (the recorded task's charge, or the hosted-tier task price for an
   * uploaded recipe). Fixed; failed runs cost nothing.
   */
  priceCredits: number;
  /** The task run it was recorded from. */
  sourceJobId?: string;
  createdAt?: string;
  updatedAt?: string;
  /** The body of the current version (getRecipe, createRecipe). */
  recipe?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface RecipeVersion {
  version: number;
  /** "draft", "active" or "retired". */
  status: string;
  /** When the version passed a run end to end; only verified versions can be promoted. */
  verifiedAt: string | null;
  promotedAt: string | null;
  createdAt?: string;
  createdFromJob?: string;
  createdFromRun?: string;
  recipe?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/** Typed failures of a run. */
export type RecipeRunErrorCode =
  | "blocked" | "needs_login" | "site_changed" | "invalid_output" | "params_invalid" | "timeout" | "failed" | "cancelled";

export interface RecipeRun {
  id: string;
  /** The agents job behind the run (same id); cancelJob works on it. */
  jobId: string;
  recipeId: string | null;
  version: number;
  /** "queued", "running", "ok", "failed" or "cancelled". */
  status: "queued" | "running" | "ok" | "failed" | "cancelled" | string;
  params: Record<string, unknown> | null;
  /** The output, checked against the recipe's output schema. */
  output: unknown;
  errorCode: RecipeRunErrorCode | string | null;
  errorMessage: string | null;
  /** The per step trace the replay worker reported. */
  layers: unknown;
  /** Step id to the layer it ran on (1 in-page network, 2 DOM, 3 repair), when the trace says. */
  layerUsed: Record<string, number> | null;
  repaired: boolean;
  repairedSteps: string[];
  /** The version a repair stored, null when none. */
  newVersion: number | null;
  durationMs: number | null;
  /** The recipe's price when the run was queued. */
  priceCredits: number;
  /** What the run charged: priceCredits when it succeeded, 0 when it failed or was cancelled. */
  credits: number;
  createdAt?: string;
  finishedAt: string | null;
  raw: Record<string, unknown>;
}

export interface CreateRecipeOptions {
  /** A task run made with recordRecipe: true. */
  fromJobId?: string;
  /** A recipe JSON to upload (services/replay/recipe.schema.json). */
  recipe?: Record<string, unknown>;
  /** Lowercase letters, digits and dashes. */
  name?: string;
  /** JSON Schema of the run params; replaces the recorded one. */
  params?: Record<string, unknown>;
  /** JSON Schema of the output; replaces the recorded one. */
  output?: Record<string, unknown>;
  repairMode?: RepairMode;
}

export interface RunRecipeOptions {
  /** Checked against the recipe's params schema (400 PARAMS_INVALID). */
  params?: Record<string, unknown>;
  /** Seconds (up to 60) to wait for the run to finish before answering. */
  wait?: number;
  /** An https URL that gets recipe.run.completed or recipe.failed for this run. */
  webhookUrl?: string;
  /** Where the browser leaves from; the recipe's exit when omitted. */
  proxy?: { network?: "auto" | "datacenter" | "residential" | "default"; country?: string };
  /** Run on a saved identity of this workspace. */
  profileId?: string;
  /** Let steps marked mutation (add to cart, submit) run. Off by default. */
  allowMutations?: boolean;
  /**
   * Workspace secrets (names or ids) the recipe's `{{secret:NAME}}` steps
   * may type. A recipe never attaches a secret itself: a step whose secret
   * is not listed is 400 SECRET_NOT_ATTACHED.
   */
  secretIds?: string[];
}

function snakeToRecipe(b: Record<string, any>): Recipe {
  return {
    id: b.id || "",
    name: b.name || "",
    status: b.status || "",
    currentVersion: typeof b.current_version === "number" ? b.current_version : null,
    repairMode: b.repair_mode || "",
    priceCredits: num(b.price_credits),
    sourceJobId: typeof b.source_job_id === "string" ? b.source_job_id : undefined,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    recipe: b.recipe && typeof b.recipe === "object" ? b.recipe : undefined,
    raw: b,
  };
}

function snakeToRecipeVersion(b: Record<string, any>): RecipeVersion {
  return {
    version: Number(b.version || 0),
    status: b.status || "",
    verifiedAt: b.verified_at ?? null,
    promotedAt: b.promoted_at ?? null,
    createdAt: b.created_at,
    createdFromJob: b.created_from_job,
    createdFromRun: b.created_from_run,
    recipe: b.recipe && typeof b.recipe === "object" ? b.recipe : undefined,
    raw: b,
  };
}

function snakeToRecipeRun(b: Record<string, any>): RecipeRun {
  return {
    id: b.id || "",
    jobId: b.job_id || b.id || "",
    recipeId: typeof b.recipe_id === "string" ? b.recipe_id : null,
    version: Number(b.version || 0),
    status: b.status || "",
    params: b.params && typeof b.params === "object" ? b.params : null,
    output: b.output ?? null,
    errorCode: b.error_code ?? null,
    errorMessage: b.error_message ?? null,
    layers: b.layers ?? null,
    layerUsed: b.layer_used && typeof b.layer_used === "object" ? b.layer_used : null,
    repaired: !!b.repaired,
    repairedSteps: Array.isArray(b.repaired_steps) ? b.repaired_steps : [],
    newVersion: typeof b.new_version === "number" ? b.new_version : null,
    durationMs: typeof b.duration_ms === "number" ? b.duration_ms : null,
    priceCredits: num(b.price_credits),
    credits: num(b.credits),
    createdAt: b.created_at,
    finishedAt: b.finished_at ?? null,
    raw: b,
  };
}

// ── Robots ────────────────────────────────────────────────────────────────

/**
 * Robot settings. Each part is optional; a missing or null part is Auto.
 * Replays use no model: `model` records the robot (and re-records it when
 * the site changed). Language and timezone follow the exit.
 */
export interface RobotSettings {
  /** A hosted tier ("browsa", "browsa-fast", "browsa-smart"), or a model of a saved key (llmKeyId). */
  model?: { llm: string; llmKeyId?: string } | null;
  /**
   * Browsa's proxy network ("datacenter" 5 credits/GB, "residential" 50
   * credits/GB, optional country), or a saved proxy of yours (proxyId, free).
   */
  proxy?: { network?: "datacenter" | "residential"; country?: string; proxyId?: string } | null;
  /** Phantom's operating system and a desktop screen size such as "1920x1080". */
  browser?: { os?: "mac" | "windows" | "linux"; screen?: string } | null;
  /**
   * Workspace secrets every row may type: names (or ids), at most 20. Each
   * row passes them to its recipe run as secretIds. `[]` (or null) is none.
   */
  secrets?: string[] | null;
}

/** Something that may stop a robot's rows from typing a secret (GET /v1/robots). */
export interface RobotSettingsWarning {
  /** SECRET_NOT_FOUND, SECRET_ORIGIN_MISMATCH, SECRET_NO_ORIGINS or SECRETS_UNAVAILABLE. */
  code: string;
  secret?: string;
  message: string;
}

/** When a robot runs on its own. `at` ("09:00"), `weekday` (0 Sunday) and `tz` apply to daily and weekly intervals. */
export interface RobotSchedule {
  intervalSeconds: number;
  at?: string;
  weekday?: number;
  tz?: string;
}

/** Where results go after a run. Webhooks are signed with X-Agents-Signature. */
export type RobotDestination =
  | { type: "webhook"; url: string; secretRef?: string }
  | { type: "email"; to: string };

/** Watch one output field on every row. `lt`, `gt` and `eq` take a value. */
export interface RobotMonitor {
  field: string;
  op: "changed" | "lt" | "gt" | "eq" | "in_stock_changed";
  value?: unknown;
}

export interface RobotHealth {
  /** Share of rows that passed over the last 20 runs, 0 to 1; null before any run. */
  passRate: number | null;
  rowsCounted: number;
  lastFailure: string | null;
  lastFailureAt: string | null;
  recipeVersion: number | null;
  versions: number;
  repairs: number;
  /** Credits one successful row costs (the recipe's price). Failed rows are free. */
  priceCredits: number;
  nextRunAt: string | null;
  scheduleActive: boolean;
  site: string | null;
  raw: Record<string, unknown>;
}

/** "queued", "running", "completed", "partial" or "failed". */
export type RobotRunStatus = "queued" | "running" | "completed" | "partial" | "failed";

export const ROBOT_RUN_TERMINAL: string[] = ["completed", "partial", "failed"];

export interface RobotRunRow {
  row: number;
  input: Record<string, unknown> | null;
  /** "ok", "failed" or a pending state. */
  status: string;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  credits: number;
  recipeRunId: string | null;
  durationMs: number | null;
  alerts: RobotAlert[];
  changedFields: string[];
}

export interface RobotRun {
  id: string;
  robotId: string;
  /** "manual", "schedule" or "api". */
  trigger: string;
  status: RobotRunStatus | string;
  rowsTotal: number;
  rowsOk: number;
  rowsFailed: number;
  rowsPending: number;
  /** What the run charged: the recipe's price per successful row. */
  credits: number;
  site: string | null;
  stopReason: string | null;
  createdAt?: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Rows with output (robotRuns.get only). */
  rows?: RobotRunRow[];
  raw: Record<string, unknown>;
}

export interface RobotAlert {
  id: string;
  robotId: string;
  robotRunId: string;
  row: number;
  field: string;
  rule: string;
  old: unknown;
  new: unknown;
  createdAt?: string;
  raw: Record<string, unknown>;
}

export interface Robot {
  id: string;
  name: string;
  description: string;
  recipeId: string | null;
  /** "active" or "paused". */
  status: "active" | "paused" | string;
  pausedReason: string | null;
  profileId: string | null;
  inputs: Record<string, unknown>[];
  destinations: RobotDestination[];
  monitors: RobotMonitor[];
  schedule: (RobotSchedule & { id: string; enabled: boolean; nextRunAt: string | null }) | null;
  /** model, proxy and browser (each null when Auto) and secrets (names or ids, [] when none). */
  settings: RobotSettings & { secrets: string[] };
  /** What may stop a row from typing one of settings.secrets. [] when nothing. */
  settingsWarnings: RobotSettingsWarning[];
  sourceJobId: string | null;
  health: RobotHealth | null;
  alertsUnread: number;
  lastRun: RobotRun | null;
  createdAt?: string;
  updatedAt?: string;
  raw: Record<string, unknown>;
}

export interface CreateRobotOptions {
  name: string;
  /** A finished task run made with recordRecipe: true. */
  fromJobId?: string;
  /** Or an existing recipe. */
  recipeId?: string;
  description?: string;
  /** One object per row, up to 500. One run covers every row. */
  inputs?: Record<string, unknown>[];
  schedule?: RobotSchedule;
  destinations?: RobotDestination[];
  monitors?: RobotMonitor[];
  /** Run on a saved identity of this workspace. */
  profileId?: string;
  settings?: RobotSettings;
}

/** Fields left out stay as they are; null clears schedule, profileId and settings (Auto). */
export interface UpdateRobotOptions {
  name?: string;
  description?: string;
  inputs?: Record<string, unknown>[];
  schedule?: RobotSchedule | null;
  destinations?: RobotDestination[];
  monitors?: RobotMonitor[];
  profileId?: string | null;
  /**
   * Changes only the parts you pass: `{ proxy: { network: "residential" } }`
   * keeps the robot's model, browser and secrets. The API replaces the
   * whole settings object, so update() reads the robot first and sends its
   * current settings with your parts over them (one extra GET). A part set
   * to null goes back to Auto; `secrets: []` removes every secret. `null`
   * for the whole object resets every part to Auto and removes the secrets.
   */
  settings?: RobotSettings | null;
  /** Re-record from a new task run. */
  fromJobId?: string;
  /** Switch to another recipe (for example back to the previous one). */
  recipeId?: string;
}

type RequestFn = <T = unknown>(
  method: string,
  path: string,
  opts?: { body?: unknown; query?: Record<string, unknown>; timeoutMs?: number },
) => Promise<T>;

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function robotSettingsToWire(s: RobotSettings | null | undefined): Record<string, unknown> | null | undefined {
  if (s === undefined) return undefined;
  if (s === null) return null;
  // A part given as null is sent as null (Auto); a part left out is not sent.
  const out: Record<string, unknown> = {};
  if (s.model !== undefined) out.model = s.model ? { llm: s.model.llm, llm_key_id: s.model.llmKeyId } : null;
  if (s.proxy !== undefined) {
    out.proxy = s.proxy ? { network: s.proxy.network, country: s.proxy.country, proxy_id: s.proxy.proxyId } : null;
  }
  if (s.browser !== undefined) out.browser = s.browser ? { os: s.browser.os, screen: s.browser.screen } : null;
  if (s.secrets !== undefined) out.secrets = s.secrets ? [...s.secrets] : [];
  return out;
}

function robotSettingsFromWire(b: any): RobotSettings & { secrets: string[] } {
  const out: RobotSettings & { secrets: string[] } = { model: null, proxy: null, browser: null, secrets: [] };
  if (!b || typeof b !== "object") return out;
  if (Array.isArray(b.secrets)) out.secrets = b.secrets.filter((x: unknown) => typeof x === "string");
  if (b.model) out.model = { llm: b.model.llm || "", ...(b.model.llm_key_id ? { llmKeyId: b.model.llm_key_id } : {}) };
  if (b.proxy) {
    out.proxy = {
      ...(b.proxy.network ? { network: b.proxy.network } : {}),
      ...(b.proxy.country ? { country: b.proxy.country } : {}),
      ...(b.proxy.proxy_id ? { proxyId: b.proxy.proxy_id } : {}),
    };
  }
  if (b.browser) {
    out.browser = { ...(b.browser.os ? { os: b.browser.os } : {}), ...(b.browser.screen ? { screen: b.browser.screen } : {}) };
  }
  return out;
}

function scheduleToWire(s: RobotSchedule | null | undefined): Record<string, unknown> | null | undefined {
  if (s === undefined || s === null) return s;
  return { interval_seconds: s.intervalSeconds, at: s.at, weekday: s.weekday, tz: s.tz };
}

function destinationsToWire(d: RobotDestination[] | undefined): unknown {
  if (d === undefined) return undefined;
  return d.map((x: any) => (x.type === "webhook" ? { type: "webhook", url: x.url, secret_ref: x.secretRef } : x));
}

function snakeToRobotAlert(b: Record<string, any>): RobotAlert {
  return {
    id: b.id || "",
    robotId: b.robot_id || "",
    robotRunId: b.robot_run_id || "",
    row: num(b.row),
    field: b.field || "",
    rule: b.rule || "",
    old: b.old ?? null,
    new: b.new ?? null,
    createdAt: b.created_at,
    raw: b,
  };
}

function snakeToRobotRun(b: Record<string, any>): RobotRun {
  const run: RobotRun = {
    id: b.id || "",
    robotId: b.robot_id || "",
    trigger: b.trigger || "",
    status: b.status || "",
    rowsTotal: num(b.rows_total),
    rowsOk: num(b.rows_ok),
    rowsFailed: num(b.rows_failed),
    rowsPending: num(b.rows_pending),
    credits: num(b.credits),
    site: strOrNull(b.site),
    stopReason: strOrNull(b.stop_reason),
    createdAt: b.created_at,
    startedAt: b.started_at ?? null,
    finishedAt: b.finished_at ?? null,
    raw: b,
  };
  if (Array.isArray(b.rows)) {
    run.rows = b.rows.map((r: Record<string, any>) => ({
      row: num(r.row),
      input: r.input && typeof r.input === "object" ? r.input : null,
      status: r.status || "",
      output: r.output ?? null,
      errorCode: r.error_code ?? null,
      errorMessage: r.error_message ?? null,
      credits: num(r.credits),
      recipeRunId: strOrNull(r.recipe_run_id),
      durationMs: typeof r.duration_ms === "number" ? r.duration_ms : null,
      alerts: Array.isArray(r.alerts) ? r.alerts.map(snakeToRobotAlert) : [],
      changedFields: Array.isArray(r.changed_fields) ? r.changed_fields : [],
    }));
  }
  return run;
}

function snakeToRobot(b: Record<string, any>): Robot {
  const h = b.health && typeof b.health === "object" ? b.health : null;
  const s = b.schedule && typeof b.schedule === "object" ? b.schedule : null;
  return {
    id: b.id || "",
    name: b.name || "",
    description: b.description || "",
    recipeId: strOrNull(b.recipe_id),
    status: b.status || "",
    pausedReason: strOrNull(b.paused_reason),
    profileId: strOrNull(b.profile_id),
    inputs: Array.isArray(b.inputs) ? b.inputs : [],
    destinations: Array.isArray(b.destinations)
      ? b.destinations.map((d: any) => (d && d.secret_ref ? { ...d, secretRef: d.secret_ref } : d))
      : [],
    monitors: Array.isArray(b.monitors) ? b.monitors : [],
    schedule: s
      ? {
          id: s.id || "",
          intervalSeconds: num(s.interval_seconds),
          enabled: !!s.enabled,
          nextRunAt: s.next_run_at ?? null,
          ...(s.at ? { at: s.at } : {}),
          ...(typeof s.weekday === "number" ? { weekday: s.weekday } : {}),
          ...(s.tz ? { tz: s.tz } : {}),
        }
      : null,
    settings: robotSettingsFromWire(b.settings),
    settingsWarnings: Array.isArray(b.settings_warnings)
      ? b.settings_warnings.filter((w: any) => w && typeof w === "object").map((w: any) => ({
          code: String(w.code || ""),
          ...(typeof w.secret === "string" ? { secret: w.secret } : {}),
          message: String(w.message || ""),
        }))
      : [],
    sourceJobId: strOrNull(b.source_job_id),
    health: h
      ? {
          passRate: typeof h.pass_rate === "number" ? h.pass_rate : null,
          rowsCounted: num(h.rows_counted),
          lastFailure: strOrNull(h.last_failure),
          lastFailureAt: h.last_failure_at ?? null,
          recipeVersion: typeof h.recipe_version === "number" ? h.recipe_version : null,
          versions: num(h.versions),
          repairs: num(h.repairs),
          priceCredits: num(h.price_credits),
          nextRunAt: h.next_run_at ?? null,
          scheduleActive: !!h.schedule_active,
          site: strOrNull(h.site),
          raw: h,
        }
      : null,
    alertsUnread: num(b.alerts_unread),
    lastRun: b.last_run && typeof b.last_run === "object" ? snakeToRobotRun(b.last_run) : null,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    raw: b,
  };
}

/** client.robots: saved browser jobs over recipes. A row costs the recipe's priceCredits; failed rows are free. */
export class Robots {
  constructor(private readonly req: RequestFn) {}

  private path(id: string, rest = ""): string {
    return `/v1/robots/${encodeURIComponent(id)}${rest}`;
  }

  /** POST /v1/robots from a recorded task run (fromJobId) or a recipe (recipeId). */
  async create(opts: CreateRobotOptions): Promise<Robot> {
    const body = {
      name: opts.name,
      from_job_id: opts.fromJobId,
      recipe_id: opts.recipeId,
      description: opts.description,
      inputs: opts.inputs,
      schedule: scheduleToWire(opts.schedule),
      destinations: destinationsToWire(opts.destinations),
      monitors: opts.monitors,
      profile_id: opts.profileId,
      settings: robotSettingsToWire(opts.settings),
    };
    return snakeToRobot(await this.req<Record<string, any>>("POST", "/v1/robots", { body }));
  }

  /** GET /v1/robots, newest first. */
  async list(opts: { limit?: number } = {}): Promise<Robot[]> {
    const r = await this.req<{ robots?: any[] }>("GET", "/v1/robots", { query: { limit: opts.limit } });
    return (r.robots ?? []).map(snakeToRobot);
  }

  /** GET /v1/robots/:id with health and the last run. */
  async get(id: string): Promise<Robot> {
    return snakeToRobot(await this.req<Record<string, any>>("GET", this.path(id)));
  }

  /**
   * PATCH /v1/robots/:id. Only the fields you pass change, and only the
   * settings parts you pass change (see UpdateRobotOptions.settings).
   */
  async update(id: string, opts: UpdateRobotOptions): Promise<Robot> {
    const body: Record<string, unknown> = {};
    const set = (k: string, v: unknown) => { if (v !== undefined) body[k] = v; };
    set("name", opts.name);
    set("description", opts.description);
    set("inputs", opts.inputs);
    set("schedule", scheduleToWire(opts.schedule));
    set("destinations", destinationsToWire(opts.destinations));
    set("monitors", opts.monitors);
    set("profile_id", opts.profileId);
    const settings = robotSettingsToWire(opts.settings);
    set("settings", settings ? await this.mergedSettings(id, settings) : settings);
    set("from_job_id", opts.fromJobId);
    set("recipe_id", opts.recipeId);
    return snakeToRobot(await this.req<Record<string, any>>("PATCH", this.path(id), { body }));
  }

  /**
   * The robot's current settings (as the API returns them) with `parts`
   * over them, key by key. PATCH /v1/robots/:id replaces settings whole, so
   * sending only the given parts would drop the others (secrets among them).
   */
  private async mergedSettings(id: string, parts: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = await this.req<Record<string, any>>("GET", this.path(id));
    const cur = current && typeof current.settings === "object" && current.settings ? current.settings : {};
    return { ...cur, ...parts };
  }

  /** DELETE /v1/robots/:id. Past runs stay billed history. */
  async delete(id: string): Promise<void> {
    await this.req("DELETE", this.path(id));
  }

  /** POST /v1/robots/:id/run. `inputs` replaces the saved rows for this run only. Returns the queued run. */
  async run(id: string, opts: { inputs?: Record<string, unknown>[] } = {}): Promise<RobotRun> {
    const body = opts.inputs ? { inputs: opts.inputs } : {};
    return snakeToRobotRun(await this.req<Record<string, any>>("POST", this.path(id, "/run"), { body }));
  }

  async pause(id: string): Promise<Robot> {
    return snakeToRobot(await this.req<Record<string, any>>("POST", this.path(id, "/pause")));
  }

  async resume(id: string): Promise<Robot> {
    return snakeToRobot(await this.req<Record<string, any>>("POST", this.path(id, "/resume")));
  }

  /** GET /v1/robots/:id/runs, newest first (no rows; robotRuns.get has them). */
  async runs(id: string, opts: { limit?: number } = {}): Promise<RobotRun[]> {
    const r = await this.req<{ runs?: any[] }>("GET", this.path(id, "/runs"), { query: { limit: opts.limit } });
    return (r.runs ?? []).map(snakeToRobotRun);
  }

  /** GET /v1/robots/:id/alerts: what the monitors caught, newest first. */
  async alerts(id: string, opts: { limit?: number } = {}): Promise<RobotAlert[]> {
    const r = await this.req<{ alerts?: any[] }>("GET", this.path(id, "/alerts"), { query: { limit: opts.limit } });
    return (r.alerts ?? []).map(snakeToRobotAlert);
  }

  /** POST /v1/robots/:id/alerts/read: alertsUnread goes to 0. */
  async markAlertsRead(id: string): Promise<void> {
    await this.req("POST", this.path(id, "/alerts/read"));
  }
}

/** client.robotRuns: one run of a robot, with a row per input. */
export class RobotRuns {
  constructor(private readonly req: RequestFn) {}

  /** GET /v1/robot-runs/:id with rows. */
  async get(id: string): Promise<RobotRun> {
    return snakeToRobotRun(await this.req<Record<string, any>>("GET", `/v1/robot-runs/${encodeURIComponent(id)}`));
  }

  /** Polls get() until the run is completed, partial or failed. */
  async wait(id: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<RobotRun> {
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const poll = opts.pollMs ?? 3_000;
    for (;;) {
      const run = await this.get(id);
      if (ROBOT_RUN_TERMINAL.includes(run.status)) return run;
      if (Date.now() + poll > deadline) {
        throw new TimeoutError(`robot run ${id} still ${run.status} after ${opts.timeoutMs ?? 600_000}ms`);
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  /**
   * GET /v1/robot-runs/:id/export. CSV (default) comes back as text, one
   * line per row; JSON as an object with `rows`. `items` caps list items per
   * CSV cell (default 5, up to 50).
   */
  async export(id: string, opts: { format: "json"; items?: number }): Promise<Record<string, any>>;
  async export(id: string, opts?: { format?: "csv"; items?: number }): Promise<string>;
  async export(id: string, opts: { format?: "csv" | "json"; items?: number } = {}): Promise<string | Record<string, any>> {
    const format = opts.format ?? "csv";
    const r = await this.req<unknown>("GET", `/v1/robot-runs/${encodeURIComponent(id)}/export`, {
      query: { format, items: opts.items },
    });
    if (format === "json" && typeof r === "string") return JSON.parse(r);
    return r as string | Record<string, any>;
  }
}

// ── Secrets ───────────────────────────────────────────────────────────────

export type SecretType = "login" | "totp" | "value";

/** A robot or schedule that names a secret (`Secret.usedBy`). */
export interface SecretUser {
  kind: "robot" | "schedule" | string;
  id: string;
  name: string;
}

/**
 * A workspace secret. Values are write-only: nothing returns a value, a seed
 * or anything derived from one except `usernameMasked`.
 */
export interface Secret {
  id: string;
  /** `[A-Z0-9_]`, unique in the workspace. Fixed after create. */
  name: string;
  type: SecretType | string;
  /** Shown to the model: what the secret is for, never the value. */
  description: string;
  /** Where it may be typed, e.g. ["https://*.github.com"]; ["*"] with anyOrigin. */
  origins: string[];
  /** Logins only, e.g. "al…@example.com". */
  usernameMasked?: string;
  hasValue: boolean;
  hasTotp: boolean;
  /** Present when the secret has a one-time-code seed. */
  totp?: { digits: number; algorithm: string; period: number };
  /** References act({ secret }) takes: "NAME:username", "NAME:password", "TOTP:NAME". */
  placeholders: string[];
  /** Typed on any https site (origins ["*"]). Not recommended. */
  anyOrigin: boolean;
  /** Saved before origins were required: typed nowhere until origins are set. */
  needsOrigins: boolean;
  warning?: string;
  /** The HPKE keypair the last sealed write used, null for a plain write. */
  keypairId: string | null;
  createdBy?: { type: "key" | "user" | string; id: string };
  /** list() and get() only: the robots and schedules that name it. */
  usedBy: SecretUser[];
  lastUsedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
  raw: Record<string, unknown>;
}

/** Fields of a secret's value, plain or sealed (see Secrets.keypair). */
export interface SecretValueFields {
  /** Logins. */
  username?: string;
  password?: string;
  /** `value` secrets (one line, 3 to 4096 characters), or a `totp` secret's seed. */
  value?: string;
  /** A base32 seed or an otpauth://totp/ URI. On update, "" removes a login's seed. */
  totpSecret?: string;
  /** 6 to 8, default 6. */
  digits?: number;
  /** "SHA1" (default), "SHA256" or "SHA512". */
  algorithm?: "SHA1" | "SHA256" | "SHA512" | string;
  /** 15 to 120 seconds, default 30. */
  period?: number;
  /** The code your authenticator shows now; checked before anything is saved. */
  totpCode?: string;
  /** Sealed forms (base64 HPKE, RFC 9180 base mode), with keypairId. Send a field plain or sealed, not both. */
  sealedUsername?: string;
  sealedPassword?: string;
  sealedValue?: string;
  sealedTotpSecret?: string;
  keypairId?: string;
}

export interface CreateSecretOptions extends SecretValueFields {
  /** `[A-Z0-9_]{1,64}`; lower case is upper-cased. */
  name: string;
  type: SecretType;
  /**
   * Where it may be typed: "example.com" (it and its subdomains),
   * "app.example.com" or "https://app.example.com" (that host only),
   * "*.example.com". ["*"] (any https site) only with allowAnyOrigin.
   */
  origins: string[];
  description?: string;
  allowAnyOrigin?: boolean;
}

export interface UpdateSecretOptions extends SecretValueFields {
  description?: string;
  origins?: string[];
  allowAnyOrigin?: boolean;
}

/** What importEnv returns. */
export interface SecretImportResult {
  secrets: Secret[];
  created: number;
  updated: number;
  /** Names left alone (onConflict "skip"). */
  skipped: string[];
  raw: Record<string, unknown>;
}

/** One use of a secret (Secrets.usage). */
export interface SecretUse {
  jobId: string | null;
  origin: string;
  /** "typed", "totp" (a one-time code was typed) or "blocked" (wrong origin, nothing typed). */
  action: "typed" | "totp" | "blocked" | string;
  /** "task" (the agent), "replay" (a recipe run) or "session" (act). */
  source: string;
  at: string;
  robotId?: string;
  robotName?: string;
}

export interface SecretUsagePage {
  usage: SecretUse[];
  /** Pass back as `cursor` for older rows; null on the last page. */
  nextCursor: string | null;
  limit: number;
  raw: Record<string, unknown>;
}

/** The server's HPKE public key for sealing values on your side. */
export interface SecretKeypair {
  id: string;
  /** base64, 32 bytes (X25519). */
  publicKey: string;
  /** kem, kdf, aead names and ids, mode "base". */
  suite: Record<string, unknown>;
  /** info = infoPrefix + the field name ("value", "username", "password", "totp_secret", "env"). */
  infoPrefix: string;
  format?: string;
  createdAt?: string;
  useUntil?: string;
  raw: Record<string, unknown>;
}

/**
 * A login a run created and saved as a workspace secret (`job.savedSecrets`).
 * Never carries a value.
 */
export interface SavedSecret {
  name: string;
  id?: string;
  type?: "login" | "value" | string;
  origins: string[];
  /** Logins only. */
  usernameMasked?: string;
  /** True when an existing secret was updated rather than created. */
  existing: boolean;
}

/** Why a run did not save the login it created (`job.secretsNotSaved`). */
export interface SecretsNotSaved {
  /**
   * KEY_SCOPE_REQUIRED (the API key lacks secrets:write), SECRET_ROLE_REQUIRED,
   * OUTPUT_SECRETS_OFF, SECRETS_UNAVAILABLE, SECRET_LIMIT, NO_USERNAME or SAVE_FAILED.
   */
  code: string;
  message: string;
}

const secretPath = (idOrName: string, rest = "") => `/v1/secrets/${encodeURIComponent(idOrName)}${rest}`;

function snakeToSecret(b: Record<string, any>): Secret {
  const t = b.totp && typeof b.totp === "object" ? b.totp : null;
  const cb = b.created_by && typeof b.created_by === "object" ? b.created_by : null;
  return {
    id: b.id || "",
    name: b.name || "",
    type: b.type || "",
    description: b.description || "",
    origins: Array.isArray(b.origins) ? b.origins : [],
    ...(typeof b.username_masked === "string" && b.username_masked ? { usernameMasked: b.username_masked } : {}),
    hasValue: b.has_value === true,
    hasTotp: b.has_totp === true,
    ...(t ? { totp: { digits: num(t.digits), algorithm: String(t.algorithm || ""), period: num(t.period) } } : {}),
    placeholders: Array.isArray(b.placeholders) ? b.placeholders : [],
    anyOrigin: b.any_origin === true,
    needsOrigins: b.needs_origins === true,
    ...(typeof b.warning === "string" && b.warning ? { warning: b.warning } : {}),
    keypairId: strOrNull(b.keypair_id),
    ...(cb ? { createdBy: { type: String(cb.type || ""), id: String(cb.id || "") } } : {}),
    usedBy: Array.isArray(b.used_by)
      ? b.used_by.filter((u: any) => u && typeof u === "object")
          .map((u: any) => ({ kind: String(u.kind || ""), id: String(u.id || ""), name: String(u.name || "") }))
      : [],
    lastUsedAt: strOrNull(b.last_used_at),
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    raw: b,
  };
}

function secretFieldsToWire(o: SecretValueFields & { description?: string; origins?: string[]; allowAnyOrigin?: boolean }): Record<string, unknown> {
  const map: Record<string, string> = {
    description: "description", origins: "origins", allowAnyOrigin: "allow_any_origin",
    username: "username", password: "password", value: "value", totpSecret: "totp_secret",
    digits: "digits", algorithm: "algorithm", period: "period", totpCode: "totp_code",
    sealedUsername: "sealed_username", sealedPassword: "sealed_password", sealedValue: "sealed_value",
    sealedTotpSecret: "sealed_totp_secret", keypairId: "keypair_id",
  };
  const out: Record<string, unknown> = {};
  for (const [src, dst] of Object.entries(map)) {
    const v = (o as any)[src];
    if (v !== undefined && v !== null) out[dst] = v;
  }
  return out;
}

function savedSecretsFromResult(result: Record<string, any>): SavedSecret[] {
  if (!Array.isArray(result.saved_secrets)) return [];
  return result.saved_secrets
    .filter((s: any) => s && typeof s === "object")
    .map((s: any) => ({
      name: String(s.name || ""),
      ...(typeof s.id === "string" && s.id ? { id: s.id } : {}),
      ...(typeof s.type === "string" && s.type ? { type: s.type } : {}),
      origins: Array.isArray(s.origins) ? s.origins.filter((o: unknown) => typeof o === "string") : [],
      ...(typeof s.username_masked === "string" && s.username_masked ? { usernameMasked: s.username_masked } : {}),
      existing: s.existing === true,
    }));
}

function secretsNotSavedFromResult(result: Record<string, any>): SecretsNotSaved | undefined {
  const n = result.secrets_not_saved;
  if (!n || typeof n !== "object" || !n.code) return undefined;
  return { code: String(n.code), message: String(n.message || "") };
}

/**
 * client.secrets: the workspace vault for what an agent may type but must
 * never read: site logins (username, password, optional one-time-code
 * seed), one-time-code seeds and plain values such as API keys. Values are
 * write-only.
 *
 * Use a secret by attaching it, by name or id, in `secretIds` on
 * createTask / runTask / auto / createSchedule / runRecipe / sendMessage
 * (or a robot's `settings.secrets`), and refer to it in the task text:
 * `secrets.NAME`, `secrets.NAME.username`, `secrets.NAME.password`,
 * `secrets.NAME.totp` (the current one-time code). Attachment is explicit:
 * a reference to a secret that is not in secretIds is 400
 * SECRET_NOT_ATTACHED, an unknown name 400 SECRET_NOT_FOUND. The older
 * `{{secret:NAME}}` and `%NAME%` forms still work. A secret is typed only
 * on its origins.
 *
 * Values may be sent plain (over TLS). To seal them on your side, fetch
 * keypair() and send the `sealed*` fields with `keypairId` (RFC 9180 HPKE
 * base mode, any standard HPKE library; this SDK adds no crypto dependency).
 * Changing secrets needs a key with the `secrets:write` scope (403
 * KEY_SCOPE_REQUIRED otherwise).
 */
export class Secrets {
  constructor(private readonly req: RequestFn) {}

  /** GET /v1/secrets: every secret of the workspace, with usedBy. */
  async list(): Promise<Secret[]> {
    return (await this.listPage()).secrets;
  }

  /** GET /v1/secrets with the workspace's secret limit. */
  async listPage(): Promise<{ secrets: Secret[]; limit: number }> {
    const r = await this.req<{ secrets?: any[]; limit?: number }>("GET", "/v1/secrets");
    return { secrets: (r?.secrets ?? []).map(snakeToSecret), limit: num(r?.limit) };
  }

  /** GET /v1/secrets/:idOrName, with usedBy. */
  async get(idOrName: string): Promise<Secret> {
    return snakeToSecret(await this.req<Record<string, any>>("GET", secretPath(idOrName)));
  }

  /** POST /v1/secrets. */
  async create(opts: CreateSecretOptions): Promise<Secret> {
    const body = { name: opts.name, type: opts.type, ...secretFieldsToWire(opts) };
    return snakeToSecret(await this.req<Record<string, any>>("POST", "/v1/secrets", { body }));
  }

  /** PATCH /v1/secrets/:idOrName. Only the fields you pass change; name and type are fixed. */
  async update(idOrName: string, opts: UpdateSecretOptions): Promise<Secret> {
    return snakeToSecret(await this.req<Record<string, any>>("PATCH", secretPath(idOrName), { body: secretFieldsToWire(opts) }));
  }

  /**
   * DELETE /v1/secrets/:idOrName. A secret a robot or schedule uses is not
   * deleted: APIError with code SECRET_IN_USE (409) and `err.body.used_by`.
   * `force: true` deletes it anyway (robots keep the name and warn,
   * schedules fail their next run with SECRET_MISSING).
   */
  async delete(idOrName: string, opts: { force?: boolean } = {}): Promise<{ deleted: boolean; id: string; name: string }> {
    return this.req("DELETE", secretPath(idOrName), { query: opts.force ? { force: 1 } : undefined });
  }

  /**
   * POST /v1/secrets/import: every `NAME=value` line of a .env text becomes a
   * `value` secret typed only on `origins`. onConflict: "fail" (default:
   * nothing is written when one name exists), "skip" or "overwrite". One
   * transaction, at most 100 lines.
   */
  async importEnv(
    env: string,
    origins: string[],
    opts: { description?: string; onConflict?: "fail" | "skip" | "overwrite"; allowAnyOrigin?: boolean } = {},
  ): Promise<SecretImportResult> {
    const body: Record<string, unknown> = { env, origins };
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.onConflict !== undefined) body.on_conflict = opts.onConflict;
    if (opts.allowAnyOrigin !== undefined) body.allow_any_origin = opts.allowAnyOrigin;
    const r = await this.req<Record<string, any>>("POST", "/v1/secrets/import", { body });
    return {
      secrets: (Array.isArray(r?.secrets) ? r.secrets : []).map(snakeToSecret),
      created: num(r?.created),
      updated: num(r?.updated),
      skipped: Array.isArray(r?.skipped) ? r.skipped : [],
      raw: r ?? {},
    };
  }

  /** GET /v1/secrets/:idOrName/usage, newest first. `limit` up to 500 (default 100). */
  async usage(idOrName: string, opts: { limit?: number; cursor?: string } = {}): Promise<SecretUsagePage> {
    const r = await this.req<Record<string, any>>("GET", secretPath(idOrName, "/usage"), {
      query: { limit: opts.limit, cursor: opts.cursor },
    });
    return {
      usage: (Array.isArray(r?.usage) ? r.usage : []).map((u: any) => ({
        jobId: strOrNull(u.job_id),
        origin: u.origin || "",
        action: u.action || "",
        source: u.source || "",
        at: u.at || "",
        ...(u.robot_id ? { robotId: u.robot_id } : {}),
        ...(u.robot_name ? { robotName: u.robot_name } : {}),
      })),
      nextCursor: strOrNull(r?.next_cursor),
      limit: num(r?.limit),
      raw: r ?? {},
    };
  }

  /** GET /v1/secrets/keypair: the server's current HPKE public key (rotated weekly). */
  async keypair(): Promise<SecretKeypair> {
    const r = (await this.req<Record<string, any>>("GET", "/v1/secrets/keypair")) ?? {};
    return {
      id: r.id || "",
      publicKey: r.public_key || "",
      suite: r.suite && typeof r.suite === "object" ? r.suite : {},
      infoPrefix: r.info_prefix || "",
      format: r.format,
      createdAt: r.created_at,
      useUntil: r.use_until,
      raw: r,
    };
  }
}

export class Client {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private fetchImpl: typeof globalThis.fetch;
  /** View sessions seen by observe()/act(): agent id -> last tab and tab -> session. */
  private pageSessions = new Map<string, { last: string; tabs: Map<string, string> }>();
  /** Robots: saved browser jobs you run on demand, on a schedule or from the API. */
  readonly robots: Robots;
  /** One run of a robot: rows, wait, export. */
  readonly robotRuns: RobotRuns;
  /** Secrets: the workspace vault (list, get, create, update, delete, importEnv, usage, keypair). */
  readonly secrets: Secrets;

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
    const req: RequestFn = (method, path, o) => this.request(method, path, o);
    this.robots = new Robots(req);
    this.robotRuns = new RobotRuns(req);
    this.secrets = new Secrets(req);
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
    return this.fetchBytes(`/v1/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`, this.timeoutMs);
  }

  /** GET a path and return the body as bytes; errors use the usual classes. */
  private async fetchBytes(path: string, timeoutMs: number): Promise<Uint8Array> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: "GET",
        signal: ctrl.signal,
        headers: { "X-API-Key": this.apiKey, "User-Agent": USER_AGENT },
      });
    } catch (e: any) {
      if (e.name === "AbortError") throw new TimeoutError(`download timed out after ${timeoutMs}ms`);
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

  // ── Recipes (replays) ──────────────────────────────────────────────────

  /**
   * POST /v1/recipes: a recipe from a task run recorded with recordRecipe
   * (`fromJobId`) or from a recipe JSON (`recipe`). Version 1 is active.
   */
  async createRecipe(opts: CreateRecipeOptions): Promise<Recipe> {
    const body: Record<string, unknown> = {
      from_job_id: opts.fromJobId,
      recipe: opts.recipe,
      name: opts.name,
      params: opts.params,
      output: opts.output,
      repair_mode: opts.repairMode,
    };
    for (const k of Object.keys(body)) if (body[k] == null) delete body[k];
    const r = await this.request<Record<string, any>>("POST", "/v1/recipes", { body });
    return snakeToRecipe(r);
  }

  /** GET /v1/recipes: this workspace's recipes, newest first. */
  async listRecipes(opts: { limit?: number } = {}): Promise<Recipe[]> {
    const r = await this.request<{ recipes?: any[] }>("GET", "/v1/recipes", { query: { limit: opts.limit } });
    return (r.recipes ?? []).map(snakeToRecipe);
  }

  /** GET /v1/recipes/:id, with the body of the current version. */
  async getRecipe(id: string): Promise<Recipe> {
    const r = await this.request<Record<string, any>>("GET", `/v1/recipes/${encodeURIComponent(id)}`);
    return snakeToRecipe(r);
  }

  /** PATCH /v1/recipes/:id: rename, or change repairMode. */
  async updateRecipe(id: string, opts: { name?: string; repairMode?: RepairMode }): Promise<Recipe> {
    const body: Record<string, unknown> = {};
    if (opts.name != null) body.name = opts.name;
    if (opts.repairMode != null) body.repair_mode = opts.repairMode;
    const r = await this.request<Record<string, any>>("PATCH", `/v1/recipes/${encodeURIComponent(id)}`, { body });
    return snakeToRecipe(r);
  }

  /** GET /v1/recipes/:id/versions, newest first. `includeRecipe` adds each body. */
  async listRecipeVersions(id: string, opts: { includeRecipe?: boolean } = {}): Promise<RecipeVersion[]> {
    const r = await this.request<{ versions?: any[] }>("GET", `/v1/recipes/${encodeURIComponent(id)}/versions`, {
      query: opts.includeRecipe ? { include: "recipe" } : undefined,
    });
    return (r.versions ?? []).map(snakeToRecipeVersion);
  }

  /** POST /v1/recipes/:id/versions/:version/promote: make a verified version the one runs use. */
  async promoteRecipeVersion(id: string, version: number): Promise<Recipe> {
    const r = await this.request<Record<string, any>>(
      "POST", `/v1/recipes/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(version))}/promote`);
    return snakeToRecipe(r);
  }

  /** POST /v1/recipes/:id/rollback: back to the previous active version, or to `version`. */
  async rollbackRecipe(id: string, opts: { version?: number } = {}): Promise<Recipe> {
    const r = await this.request<Record<string, any>>("POST", `/v1/recipes/${encodeURIComponent(id)}/rollback`, {
      body: opts.version != null ? { version: opts.version } : {},
    });
    return snakeToRecipe(r);
  }

  /** DELETE /v1/recipes/:id. Its runs stay readable. */
  async deleteRecipe(id: string): Promise<void> {
    await this.request("DELETE", `/v1/recipes/${encodeURIComponent(id)}`);
  }

  /**
   * POST /v1/recipes/:id/run. With `wait` (seconds, up to 60) the call
   * returns the finished run when it ends in time; otherwise the queued run
   * (poll getRecipeRun). A successful run costs the recipe's priceCredits;
   * failed runs cost nothing.
   */
  async runRecipe(id: string, opts: RunRecipeOptions = {}): Promise<RecipeRun> {
    const body: Record<string, unknown> = { params: opts.params ?? {} };
    if (opts.wait != null) body.wait = opts.wait;
    if (opts.webhookUrl != null) body.webhook_url = opts.webhookUrl;
    if (opts.proxy != null) body.proxy = opts.proxy;
    if (opts.profileId != null) body.profile_id = opts.profileId;
    if (opts.allowMutations) body.allow_mutations = true;
    if (opts.secretIds != null) body.secret_ids = opts.secretIds;
    const wait = Math.min(Math.max(opts.wait ?? 0, 0), 60);
    const r = await this.request<Record<string, any>>("POST", `/v1/recipes/${encodeURIComponent(id)}/run`, {
      body,
      timeoutMs: wait > 0 ? (wait + 10) * 1000 : undefined,
    });
    return snakeToRecipeRun(r);
  }

  /** GET /v1/recipe-runs/:id. `wait` (seconds, up to 60) holds the answer until the run ends. */
  async getRecipeRun(runId: string, opts: { wait?: number } = {}): Promise<RecipeRun> {
    const wait = Math.min(Math.max(opts.wait ?? 0, 0), 60);
    const r = await this.request<Record<string, any>>("GET", `/v1/recipe-runs/${encodeURIComponent(runId)}`, {
      query: wait > 0 ? { wait } : undefined,
      timeoutMs: wait > 0 ? (wait + 10) * 1000 : undefined,
    });
    return snakeToRecipeRun(r);
  }

  /** POST /v1/recipe-runs/:id/cancel: cancel a queued or running run (the job cancel path). */
  async cancelRecipeRun(runId: string): Promise<RecipeRun> {
    const r = await this.request<Record<string, any>>("POST", `/v1/recipe-runs/${encodeURIComponent(runId)}/cancel`);
    return snakeToRecipeRun(r);
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

  // ── Page view: observe and act without CDP ─────────────────────────────

  private pageSession(agentId: string, tab: string | undefined, session: string | undefined): string | undefined {
    if (session !== undefined) return session || undefined;
    const seen = this.pageSessions.get(agentId);
    return seen ? seen.tabs.get(tab ?? seen.last) : undefined;
  }

  private rememberPage<T extends { tab?: string; session?: string }>(agentId: string, r: T): T {
    if (r && r.tab && r.session) {
      const seen = this.pageSessions.get(agentId) ?? { last: "", tabs: new Map<string, string>() };
      seen.last = r.tab;
      seen.tabs.set(r.tab, r.session);
      this.pageSessions.set(agentId, seen);
    }
    return r;
  }

  /**
   * GET /v1/agents/{id}/downloads: the files a running browser has
   * downloaded, newest first. The folder is removed when the browser stops,
   * so fetch files first. Free.
   */
  async listDownloads(agentId: string): Promise<DownloadedFile[]> {
    const r = await this.request<{ files?: DownloadedFile[] }>("GET", `/v1/agents/${encodeURIComponent(agentId)}/downloads`);
    return r?.files ?? [];
  }

  /**
   * GET /v1/agents/{id}/downloads/{name}: one downloaded file's bytes.
   * `name` comes from listDownloads(). Free.
   */
  async downloadFile(agentId: string, name: string): Promise<Uint8Array> {
    return this.fetchBytes(
      `/v1/agents/${encodeURIComponent(agentId)}/downloads/${encodeURIComponent(name)}`,
      Math.max(this.timeoutMs, 120_000),
    );
  }

  /**
   * POST /v1/agents/{id}/live: a Phantom Live link to a running browser.
   * A link opens once: make one per person or tab, and call this again for
   * another. Free.
   */
  async createLiveLink(agentId: string, opts: LiveLinkOptions = {}): Promise<LiveLink> {
    const body: Record<string, unknown> = {};
    if (opts.scope != null) body.scope = opts.scope;
    if (opts.ttlSeconds != null) body.ttl_seconds = opts.ttlSeconds;
    if (opts.jobId != null) body.job_id = opts.jobId;
    return this.request<LiveLink>("POST", `/v1/agents/${encodeURIComponent(agentId)}/live`, { body });
  }

  /**
   * POST /v1/agents/{id}/observe: the page of a running browser as compact
   * text for a model, one line per element (`[id] role "name"  state`),
   * inside a token budget. Use the ids with act(). Free.
   *
   * Ids are valid while the server keeps its view session (`session`).
   * `ids_reset: true` means this call started a new one: ids from earlier
   * answers are not valid. The client sends the last `session` it saw.
   */
  async observe(agentId: string, opts: ObserveOptions = {}): Promise<PageView> {
    const { session, ...rest } = opts;
    const body: Record<string, unknown> = { ...rest };
    const sess = this.pageSession(agentId, opts.tab, session);
    if (sess) body.session = sess;
    const r = await this.request<PageView>("POST", `/v1/agents/${encodeURIComponent(agentId)}/observe`, {
      body, timeoutMs: 90_000,
    });
    return this.rememberPage(agentId, r);
  }

  /**
   * POST /v1/agents/{id}/act: one action in a running browser, with real
   * input events; returns what changed instead of the whole page. Free.
   *
   *   await c.act(id, { action: "type", id: 14, text: "10115", clear: true });
   *   await c.act(id, { action: "click", role: "button", name: "Continue" });
   *   await c.act(id, { action: "navigate", url: "https://example.com" });
   *
   * `status` is "ok", "failed", "blocked", "challenge" or "stale"; none of
   * them throws. "stale": the id is from a view the server no longer has;
   * nothing was done and `text` carries a new view to pick from.
   */
  async act(agentId: string, action: PageAction): Promise<ActResult> {
    const { session, ...rest } = action;
    const body: Record<string, unknown> = { ...rest };
    const sess = this.pageSession(agentId, action.tab, session);
    if (sess) body.session = sess;
    const r = await this.request<ActResult>("POST", `/v1/agents/${encodeURIComponent(agentId)}/act`, {
      body, timeoutMs: 90_000,
    });
    return this.rememberPage(agentId, r);
  }

  /**
   * POST /v1/auto — smart-router. Same body as createTask but the
   * platform inspects the task wording:
   *  - fetch-only tasks ("go to URL, return text/h1/json", no
   *    clicks/types) short-circuit to /v1/quick/scrape (~5s response).
   *  - interactive tasks fall through to a regular task (job_id).
   *
   * Response carries `routed_via: "scrape" | "task"` for client branching.
   *
   * secretIds / saveSecrets: as on createTask. A task that names a secret
   * always runs as an agent task, never the plain fetch.
   */
  async auto(task: string, opts: {
    llm?: string; llmApiKey?: string; llmKeyId?: string; llmBaseUrl?: string;
    maxSteps?: number; maxCostUsd?: number; maxCredits?: number; country?: string;
    reasoning?: Reasoning;
    secretIds?: string[]; saveSecrets?: boolean;
    [k: string]: any;
  } = {}): Promise<Record<string, any>> {
    const { llm, llmApiKey, llmKeyId, llmBaseUrl, maxSteps, maxCostUsd, maxCredits, country, secretIds, saveSecrets, ...rest } = opts;
    const body: Record<string, any> = { task, ...rest };
    if (secretIds != null) body.secret_ids = secretIds;
    if (saveSecrets != null) body.save_secrets = saveSecrets;
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
    const cdpWsBase = DEFAULT_CDP_BASE_URL.replace(/^https:/, "wss:");
    const cdpHttp = (agent.cdp_http as string) || (profileId ? `${DEFAULT_CDP_BASE_URL}/api/v1/cdp/${profileId}` : "");
    const cdpUrl  = (agent.cdp_url  as string) || (profileId ? `${cdpWsBase}/api/v1/cdp/${profileId}/ws/page/...` : "");
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

