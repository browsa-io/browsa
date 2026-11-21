// The optional tool groups (BROWSA_MCP_TOOLS): the tools of @browsa/mcp 0.5
// other than observe and act, which the core tools replace. Answers keep the
// 0.5 JSON shapes. Turned on per group in server.ts.

import { Client } from "browsa";
import { apiGet, apiPost, BrowsaError } from "./api.js";
import { captchaCall, runCaptchaTask } from "./captcha/client.js";
import { chargedCredits, guardedSolve, priceOf } from "./captcha/tools.js";
import { API_KEY, BASE_URL, BASE_URL_SET } from "./config.js";

// Unset by default: with a saved key the server picks the model for the
// key's provider. A per-task key (llm_api_key) needs a model, so it gets
// BYOK_DEFAULT_LLM when neither the call nor BROWSA_LLM names one.
const DEFAULT_LLM = process.env.BROWSA_LLM || undefined;
const BYOK_DEFAULT_LLM = "claude-opus-5-5";
const DEFAULT_LLM_KEY = process.env.BROWSA_LLM_API_KEY || undefined;
const DEFAULT_LLM_KEY_ID = process.env.BROWSA_LLM_KEY_ID || undefined;
const DEFAULT_COUNTRY = process.env.BROWSA_COUNTRY;
const LLM_KEYS_URL = "https://app.browsa.io/dashboard/llm-keys";

// Only read inside tool calls, which server.ts refuses first when there is no key.
const client = (API_KEY
  ? new Client({ apiKey: API_KEY, ...(BASE_URL_SET ? { baseUrl: BASE_URL } : {}) })
  : null) as Client;

// ── Tool catalog ────────────────────────────────────────────────────────

const REASONING_PROP = {
  type: "string",
  enum: ["low", "medium", "high"],
  description: "How much the model reasons. Omit for the tier's or the provider's default.",
} as const;

export const legacyTools = [
  {
    name: "run_task",
    description:
      "Run a browser-driven AI task on a fresh Phantom cloud browser. " +
      "Returns the final result, the outcome and the total steps. `status: completed` " +
      "only means the run ended: read `outcome`. `outcome: failed` with " +
      "`status: completed` means the agent finished but could not do the task, and " +
      "`final_result` says what stopped it. Use this when the " +
      "user asks for anything web-shaped: scrape, fill, click, extract, login, " +
      "place an order, search, summarize a page, etc. The browser is a real " +
      "macOS-Chrome-fingerprinted Phantom browser with built-in captcha solving " +
      "(the measured types are listed at https://browsa.io/captcha) and behavioral " +
      "humanization. Default timeout: 10 minutes. When the run creates a login (a signup), " +
      "the result may list it in `saved_secrets` (saved as a workspace secret, never the value).",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description:
            "Plain-English instructions for the browser agent. Be specific " +
            "about what to extract and the desired output shape (JSON, list, " +
            "etc.). Example: 'Go to news.ycombinator.com and return the top 3 " +
            "story titles + URLs as JSON.'",
        },
        llm: {
          type: "string",
          description:
            `LLM identifier, provider:model, e.g. anthropic:claude-sonnet-5-5` +
            `${DEFAULT_LLM ? ` (default: ${DEFAULT_LLM})` : ""}. Omit to use the workspace's default saved key ` +
            `with its provider's default model; if no key is saved at all, the task runs on Browsa's hosted ` +
            `model and the result says so. Hosted tiers need no LLM key and add a flat credit surcharge per ` +
            `task (see list_models): "browsa" (default hosted model), "browsa-fast" (fastest and lightest), ` +
            `"browsa-smart" (for harder tasks). When you name a model, there is no hosted fallback.`,
        },
        reasoning: REASONING_PROP,
        llm_key_id: {
          type: "string",
          description:
            "Id of a saved LLM key of this workspace (see list_llm_keys). " +
            `Default: ${DEFAULT_LLM_KEY_ID ? "BROWSA_LLM_KEY_ID" : "none"}. Usually not needed: with no key ` +
            "given, the workspace's default saved key for the provider of llm is used.",
        },
        llm_api_key: {
          type: "string",
          description:
            "Per-task LLM provider key. Rarely needed: prefer a saved key (llm_key_id, or the " +
            "workspace default) so the secret never passes through the chat. Overrides llm_key_id.",
        },
        country: {
          type: "string",
          description: `2-letter egress country (e.g. US, GB, DE). Default: ${DEFAULT_COUNTRY ?? "auto"}.`,
        },
        max_steps: { type: "integer", description: "Max agent steps. Default 25. Increase for complex multi-page tasks." },
        initial_url: { type: "string", description: "Optional pre-navigation URL (saves the first agent step)." },
        ja3_profile: {
          type: "string",
          description: "TLS handshake spoof profile (e.g. macos_chrome_137). Useful for TLS-fingerprinted sites.",
        },
        profile_id: {
          type: "string",
          description:
            "Id of a persistent identity (agt_..., from list_identities). If set, reuses that browser " +
            "identity (cookies, history, fingerprint stay sticky). Omit for a fresh burner.",
        },
        secret_ids: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
          description:
            "Names or ids of workspace secrets the task may type; refer to them in the task as secrets.NAME " +
            "(or secrets.NAME.username, .password, .totp).",
        },
        save_secrets: {
          type: "boolean",
          description: "Set false to stop the run from saving a login it creates as a workspace secret (on by default).",
        },
        timeout_minutes: {
          type: "integer",
          description: "Max wall-clock minutes to wait before returning. Default 10.",
          minimum: 1,
          maximum: 30,
        },
      },
    },
  },
  {
    name: "get_job",
    description:
      "Fetch the current state of a previously-submitted job by UUID. Returns " +
      "status (queued|running|completed|failed|input_required; a cancelled job is failed with " +
      "error_code CANCELLED), step " +
      "count, final_result text if terminal, and the live_url of the browser's live " +
      "view while it runs. Cheap — call repeatedly to poll a long-running job started by run_task.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string", description: "Job UUID returned by run_task or list_jobs." },
        wait_seconds: {
          type: "integer",
          description: "If set (1-120), block server-side until the job reaches a terminal state or N seconds elapse.",
          minimum: 0,
          maximum: 120,
        },
      },
    },
  },
  {
    name: "cancel_job",
    description:
      "Cancel a queued or running job. The job ends as failed with error_code CANCELLED and keeps its " +
      "browser charge. A job that already finished returns an error with code JOB_NOT_CANCELLABLE.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string", description: "Job UUID." } },
    },
  },
  {
    name: "respond_to_job",
    description:
      "Answer an input_required prompt (CAPTCHA solution, human decision point). Flips the job back to running.",
    inputSchema: {
      type: "object",
      required: ["job_id", "response"],
      properties: {
        job_id: { type: "string" },
        response: { type: "string", description: "Your answer to the agent's question." },
      },
    },
  },
  {
    name: "start_browser",
    description:
      "Start a real cloud browser and return its CDP URL, so you can drive it yourself with any CDP client " +
      "instead of handing the work to run_task (the core open, observe and act tools need no CDP). Use this when you want to write " +
      "the browser steps, or need the page open across several of your own tool calls. Billed per browser; " +
      "always call stop_browser when you are done. Without a proxy the browser uses Browsa's data-center IP.",
    inputSchema: {
      type: "object",
      properties: {
        ttl: { type: "string", description: "How long to keep it, e.g. \"5m\" or \"1h\". Default 10m." },
        country: { type: "string", description: "ISO-2 country, e.g. \"us\". Takes effect only with a proxy." },
        os_type: { type: "string", description: "Operating system the browser presents, e.g. \"macos\", \"windows\"." },
        profile_id: {
          type: "string",
          description:
            "Reuse a saved identity (see list_identities) so the browser starts with its cookies and logins.",
        },
        proxy: {
          type: "object",
          description:
            "One of two forms. Your own proxy: give host and port, or server as \"host:port\" / " +
            "\"socks5://host:port\", plus username and password when it needs them. Or a tier of Browsa's " +
            "built-in proxy network, billed per GB from credits: {\"network\": \"datacenter\"} or " +
            "{\"network\": \"residential\", \"country\": \"us\"}, with nothing else next to network. " +
            "The built-in network works only when the proxy_network tool reports enabled: call it first " +
            "for the tiers, their countries and the price per GB.",
          properties: {
            network: { type: "string", enum: ["datacenter", "residential"], description: "Built-in network tier. Not together with host, port, server, username, password or type." },
            country: { type: "string", description: "Lowercase ISO alpha-2 exit country, e.g. \"us\". Optional." },
            type: { type: "string", enum: ["http", "https", "socks5"], description: "Own proxy only." },
            host: { type: "string", description: "Own proxy only." },
            port: { type: "integer", description: "Own proxy only." },
            server: { type: "string", description: "Own proxy only: \"host:port\" or \"scheme://host:port\"." },
            username: { type: "string", description: "Own proxy only." },
            password: { type: "string", description: "Own proxy only." },
          },
        },
      },
    },
  },
  {
    name: "proxy_network",
    description:
      "Say whether Browsa's built-in proxy network is enabled on this server and, when it is, list its " +
      "tiers (datacenter, residential) with the exit countries of each and the price per GB in credits. " +
      "Call this before passing proxy {\"network\": ...} to start_browser. When enabled is false, only " +
      "your own proxy can be used.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stop_browser",
    description:
      "Stop a browser started with start_browser and release it. Always call this when finished; an unused " +
      "browser keeps running until its ttl expires.",
    inputSchema: {
      type: "object",
      required: ["browser_id"],
      properties: { browser_id: { type: "string", description: "The id returned by start_browser." } },
    },
  },
  {
    name: "list_browsers",
    description: "List this workspace's browsers (burners and saved identities) with their status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "credits",
    description: "Get the current credit balance + available top-up packs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_webhooks",
    description: "List webhook subscriptions for this workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_webhook",
    description:
      "Register a callback URL the platform will POST lifecycle events to (HMAC-SHA256 signed via X-Agents-Signature). " +
      "Use the verify helper from browsa/webhooks in your receiver.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "HTTPS endpoint you control." },
        events: {
          type: "array",
          items: { type: "string" },
          description:
            "Event filter. Omit/empty for ALL events. Examples: job.completed, job.failed, agent.started.",
        },
      },
    },
  },
  {
    name: "delete_webhook",
    description: "Delete (disable) a webhook subscription by id.",
    inputSchema: {
      type: "object",
      required: ["webhook_id"],
      properties: { webhook_id: { type: "string" } },
    },
  },
  {
    name: "list_identities",
    description:
      "List persistent browser identities (long-lived cookies/history/fingerprint, billed monthly). Use one in " +
      "run_task via profile_id (or open via profile) to reuse a warmed-up session: it matters on sites that check " +
      "cookie age, session continuity or behavioral history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_schedule",
    description:
      "Schedule a browser task to run automatically on a fixed interval (min 1 hour). Each run is a " +
      "normal billed task. LLM key: same rules as run_task (the workspace's default saved key unless " +
      "llm_key_id is given); the schedule stores only the saved key's id. With no llm and no saved key, " +
      "the schedule runs on Browsa's hosted model and the result says so. Pass llm \"browsa\", " +
      "\"browsa-fast\" or \"browsa-smart\" to choose a hosted tier.",
    inputSchema: {
      type: "object",
      required: ["task", "interval_seconds"],
      properties: {
        task: { type: "string", description: "Plain-English task instructions (same as run_task)." },
        interval_seconds: { type: "integer", description: "Run interval in seconds. 3600 (1h) – 2592000 (30d).", minimum: 3600, maximum: 2592000 },
        name: { type: "string", description: "Optional label for the schedule." },
        llm: {
          type: "string",
          description:
            `LLM id${DEFAULT_LLM ? ` (default ${DEFAULT_LLM})` : ""}. Omit to use the workspace's default saved key ` +
            `(hosted model if none is saved). Hosted tiers: "browsa", "browsa-fast", "browsa-smart".`,
        },
        reasoning: REASONING_PROP,
        llm_key_id: { type: "string", description: "Id of a saved LLM key (see list_llm_keys). Optional." },
        llm_api_key: {
          type: "string",
          description: "Per-schedule LLM key. Rarely needed: prefer a saved key. Overrides llm_key_id.",
        },
        country: { type: "string", description: "2-letter egress country." },
        max_steps: { type: "integer", description: "Max agent steps per run." },
        initial_url: { type: "string", description: "Optional pre-navigation URL." },
      },
    },
  },
  {
    name: "list_schedules",
    description: "List this workspace's scheduled tasks (id, task, interval, next run, run count). Secrets redacted.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_llm_keys",
    description:
      "List the LLM provider keys saved in this workspace: id, name, provider, masked key (prefix + last 4), " +
      "whether it is the default for its provider, and its status (valid, invalid or unchecked). Never returns " +
      "a secret. Pass an id as llm_key_id to run_task or create_schedule. Keys are added at " +
      LLM_KEYS_URL + ".",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_models",
    description:
      "List the hosted tiers (browsa, browsa-fast, browsa-smart: the model each runs on, its default reasoning " +
      "and credits per task) and the providers a saved or per-task LLM key can be for. Read-only and free.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_job_files",
    description: "List the output files a task wrote — extracted data + a session.gif recording. Returns name + size per file.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string", description: "The job id from run_task / create_task." } },
    },
  },
  {
    name: "list_robots",
    description:
      "List this workspace's robots: saved browser jobs over a recorded recipe, each with its input rows, " +
      "schedule, model/proxy/browser settings, health (pass rate, last failure) and last run. price_credits is " +
      "what one successful row costs (the recipe's price, the same as the agent task); failed rows are free. " +
      "Robots are made at https://app.browsa.io (Robots) or with the API.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "At most this many robots (default 50)." } },
    },
  },
  {
    name: "run_robot",
    description:
      "Run a robot over all its input rows (or the rows you pass, for this run only). Replays the recorded " +
      "recipe on Phantom with no model, so it is fast. Costs the robot's price_credits per successful row; " +
      "failed rows are free. Returns the run; with wait_seconds it waits for the rows and returns them.",
    inputSchema: {
      type: "object",
      required: ["robot_id"],
      properties: {
        robot_id: { type: "string", description: "From list_robots." },
        inputs: {
          type: "array",
          items: { type: "object" },
          description: "Rows for this run only, e.g. [{\"url\": \"https://...\"}]. Omit to use the robot's saved rows.",
        },
        wait_seconds: { type: "number", description: "Wait up to this long for the run to finish (0 to 300, default 0)." },
      },
    },
  },
  {
    name: "get_robot_run",
    description:
      "Read one robot run: status (queued, running, completed, partial, failed), credits charged, and a row " +
      "per input with its output, typed error (blocked, needs_login, site_changed, invalid_output, timeout) " +
      "and the fields a monitor flagged as changed.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: { run_id: { type: "string", description: "From run_robot or list_robots (last_run.id)." } },
    },
  },
  {
    name: "solve_captcha_task",
    description:
      "Solve one captcha through Browsa's captcha API (the common createTask / getTaskResult format) " +
      "and return its solution: a token to submit with the site's form, " +
      "the text in an image, or the grid tiles to click. Use it when code or a page outside a Browsa browser " +
      "needs a captcha answer; inside run_task the browser solves captchas itself. Charged only when solved. " +
      "Measured pass rates per type: https://browsa.io/captcha. Token tasks can take up to about 2 minutes.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "object",
          description:
            "The createTask task. `type` is one of: ImageToTextTask {body: base64 image} -> {text}; " +
            "ReCaptchaV2Classification {image: base64, question: '/m/...' id or words} -> {objects}; " +
            "ReCaptchaV2TaskProxyLess / ReCaptchaV2EnterpriseTaskProxyLess {websiteURL, websiteKey, isInvisible?} -> {gRecaptchaResponse}; " +
            "ReCaptchaV3TaskProxyLess / ReCaptchaV3EnterpriseTaskProxyLess {websiteURL, websiteKey, pageAction?} -> {gRecaptchaResponse}; " +
            "AntiTurnstileTaskProxyLess {websiteURL, websiteKey, metadata?: {action?, cdata?}} -> {token}. " +
            "Without ProxyLess the task also needs proxy: 'http://user:pass@host:port'. " +
            "Other services' names (RecaptchaV2TaskProxyless, TurnstileTaskProxyless) are accepted.",
          properties: { type: { type: "string" } },
          required: ["type"],
        },
        timeout_seconds: { type: "number", description: "How long to wait for the solution. Default 180, at most 600." },
      },
    },
  },
  {
    name: "list_captcha_types",
    description:
      "List the captcha task types Browsa's captcha API accepts: whether each is live or off, its required and " +
      "optional parameters, its price per solve and, where measured, its pass rate with the date of the run. " +
      "Call it before solve_captcha_task when unsure of a type name or of a parameter: names are case-sensitive. " +
      "Uses no credits.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Only this type, with the description of every parameter." },
        live_only: { type: "boolean", description: "Leave out the types that are switched off." },
      },
    },
  },
  {
    name: "report_captcha_result",
    description:
      "Tell Browsa whether the site accepted a solution from solve_captcha_task: correct=true records that it worked, " +
      "correct=false that the site refused it. An incorrect report refunds that solve once, within the workspace's report limits; the answer says whether it did (refunded). A task can be " +
      "reported once, within 15 minutes of the solve. " +
      "Report only what the site itself answered.",
    inputSchema: {
      type: "object",
      required: ["task_id", "correct"],
      properties: {
        task_id: { type: "string", description: "task_id from solve_captcha_task." },
        correct: { type: "boolean", description: "true when the site accepted the solution, false when it refused it." },
      },
    },
  },
] as const;


// ── Tool dispatch ───────────────────────────────────────────────────────

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
  };
}

function fail(message: string, extra?: Record<string, unknown>) {
  const body = extra ? { error: message, ...extra } : { error: message };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
  };
}

type LlmChoice = {
  llm?: string;
  llmApiKey?: string;
  llmKeyId?: string;
  /** per_task: a key in the request; saved: by id; default: the workspace default saved key; hosted: a hosted tier. */
  source: "per_task" | "saved" | "default" | "hosted";
};

// Which LLM key to send. Per-call arguments beat env defaults, and a
// per-task key beats a saved key id (the server's own order). With no key
// at all, nothing is sent and the server uses the workspace's default saved
// key, so the MCP config never needs the LLM secret.
function chooseLlm(args: Record<string, any>): LlmChoice {
  const llm: string | undefined = args.llm ?? DEFAULT_LLM;
  // Hosted tiers ("browsa", "browsa-fast", "browsa-smart") take no key.
  const tier = String(llm ?? "").trim().toLowerCase();
  if (tier === "browsa" || tier.startsWith("browsa-")) return { llm: tier, source: "hosted" };
  if (args.llm_api_key) return { llm: llm ?? BYOK_DEFAULT_LLM, llmApiKey: args.llm_api_key, source: "per_task" };
  if (args.llm_key_id) return { llm, llmKeyId: args.llm_key_id, source: "saved" };
  if (DEFAULT_LLM_KEY) return { llm: llm ?? BYOK_DEFAULT_LLM, llmApiKey: DEFAULT_LLM_KEY, source: "per_task" };
  if (DEFAULT_LLM_KEY_ID) return { llm, llmKeyId: DEFAULT_LLM_KEY_ID, source: "saved" };
  return { llm, source: "default" };
}

const HOSTED: LlmChoice = { llm: "browsa", source: "hosted" };

const NO_KEY_HELP =
  "No LLM key for this task: the workspace has no default saved key for this model's provider. " +
  `Save a key at ${LLM_KEYS_URL} (the first key of a provider becomes its default), ` +
  "or set BROWSA_LLM_API_KEY in the MCP env, or pass llm:\"browsa\" to run on Browsa's hosted model.";

const HOSTED_FALLBACK_TASK_NOTE =
  "No saved LLM key found, so this ran on Browsa's hosted model (adds credits per task; see list_models). " +
  `Save a key at ${LLM_KEYS_URL} to use your own.`;
const HOSTED_FALLBACK_SCHEDULE_NOTE =
  "No saved LLM key found, so this schedule runs on Browsa's hosted model (adds credits per run; see list_models). " +
  `Save a key at ${LLM_KEYS_URL} and create the schedule again to use your own.`;

// Zero-config: the caller named no model and no key (and no env default
// does), and the server has no saved key to use. Then, like before saved
// keys existed, the call runs on Browsa's hosted model instead of failing.
function canFallBackToHosted(e: InstanceType<typeof BrowsaError>, choice: LlmChoice): boolean {
  if (choice.source !== "default" || choice.llm !== undefined) return false;
  return (e.status === 400 && e.code === "LLM_KEY_REQUIRED") ||
    (e.status === 503 && e.code === "LLM_KEYS_UNAVAILABLE");
}

// Submit with the chosen key; on a zero-config "no key" answer, retry once
// on the hosted model and return a note saying so.
async function submitWithHostedFallback<T>(
  choice: LlmChoice,
  submit: (c: LlmChoice) => Promise<T>,
): Promise<{ result: T; fellBack: boolean }> {
  try {
    return { result: await submit(choice), fellBack: false };
  } catch (e) {
    if (e instanceof BrowsaError && canFallBackToHosted(e, choice)) {
      return { result: await submit(HOSTED), fellBack: true };
    }
    throw e;
  }
}

// Turn the server's errors about LLM keys into errors that say what to do.
function llmKeyError(e: InstanceType<typeof BrowsaError>, choice: LlmChoice) {
  const extra = { code: e.code, status: e.status, request_id: e.requestId, server_error: e.message };
  if (choice.source === "hosted" || choice.source === "per_task") return null;
  switch (e.code) {
    case "LLM_KEY_REQUIRED":
      return fail(NO_KEY_HELP, extra);
    case "LLM_KEY_NOT_FOUND":
      return fail(`Saved LLM key ${choice.llmKeyId} was not found in this workspace. Call list_llm_keys to see the saved keys.`, extra);
    case "LLM_KEY_REJECTED":
      return fail(`The provider rejected the saved LLM key. Rotate it at ${LLM_KEYS_URL}, or pick another key with llm_key_id.`, extra);
    case "LLM_KEY_PROVIDER_MISMATCH":
      return fail("The saved LLM key is for a different provider than llm. Omit llm to use the key's default model, or pick a matching model.", extra);
    case "LLM_MODEL_REQUIRED":
      return fail("This saved key is for a compatible endpoint (openai_compatible), so the model must be named: pass llm with the model id your endpoint serves.", extra);
    case "LLM_KEYS_UNAVAILABLE":
      return fail(
        "Saved LLM keys are not available on this Browsa server. Set BROWSA_LLM_API_KEY in the MCP env, " +
          "pass llm_api_key, or pass llm:\"browsa\" to run on Browsa's hosted model.",
        extra,
      );
  }
  return null;
}

// GET /v1/proxy-network: the built-in proxy network. Uses fetch directly so
// it does not depend on the installed browsa SDK version having
// proxyNetwork(). An API without the endpoint (404) reads as not enabled.
async function proxyNetwork() {
  const resp = await fetch(`${BASE_URL}/v1/proxy-network`, {
    headers: { "X-API-Key": API_KEY!, Accept: "application/json", "User-Agent": "browsa-mcp" },
  });
  const body: any = await resp.json().catch(() => ({}));
  if (resp.status === 404) return { enabled: false, tiers: [] };
  if (!resp.ok) {
    throw new BrowsaError(body?.error || `HTTP ${resp.status}`, { code: body?.code, requestId: body?.request_id, status: resp.status });
  }
  const tiers = body?.enabled === true && Array.isArray(body?.tiers) ? body.tiers : [];
  return {
    enabled: body?.enabled === true,
    tiers: tiers.map((t: any) => ({
      network: t?.network, credits_per_gb: t?.credits_per_gb, mb_per_credit: t?.mb_per_credit,
      countries: Array.isArray(t?.countries) ? t.countries : [],
    })),
  };
}

// The proxy usage of a job or a browser, only when it went through the
// built-in network.
function proxyUsage(raw: any): Record<string, unknown> {
  if (!raw || typeof raw.proxy_network !== "string" || !raw.proxy_network) return {};
  return { proxy_network: raw.proxy_network, proxy_bytes: raw.proxy_bytes ?? 0, proxy_credits: raw.proxy_credits ?? 0 };
}

// GET /v1/models as the API sends it: models and credit numbers are server
// settings, so nothing here is hardcoded.
async function listModels() {
  const body = await apiGet("/v1/models");
  return { hosted: body?.hosted ?? [], own_key: body?.own_key ?? {} };
}

// The LLM side of a finished job, from its result. Jobs that have none of
// these (older jobs, or still running) add nothing to the tool result.
// How the run ended, in the API's own words. A job can be `completed` and
// still not have done the task (outcome "failed"), so every job result
// carries these. Empty signals are left out.
function outcomeFields(job: { outcome?: string; outcomeMessage?: string; signals?: unknown[] }) {
  return {
    outcome: job.outcome,
    outcome_message: job.outcomeMessage,
    ...(job.signals && job.signals.length ? { signals: job.signals } : {}),
  };
}

function llmResultFields(job: { raw?: Record<string, any> }) {
  const r = job.raw?.result;
  if (!r || typeof r !== "object") return {};
  return { llm_tier: r.llm_tier, reasoning: r.reasoning, usage: r.usage, llm_cost_usd: r.llm_cost_usd };
}

// Logins the run saved as workspace secrets (names, sites, masked username;
// never a value) and why one was not saved. Left out when absent.
function savedSecretFields(job: { raw?: Record<string, any> }) {
  const r = job.raw?.result;
  if (!r || typeof r !== "object") return {};
  const saved = Array.isArray(r.saved_secrets)
    ? r.saved_secrets.filter((s: any) => s && typeof s === "object").map((s: any) => ({
        name: s.name, id: s.id, type: s.type, origins: s.origins,
        ...(s.username_masked ? { username_masked: s.username_masked } : {}),
        existing: s.existing === true,
      }))
    : [];
  const notSaved = r.secrets_not_saved && typeof r.secrets_not_saved === "object" && r.secrets_not_saved.code
    ? { code: r.secrets_not_saved.code, message: r.secrets_not_saved.message }
    : undefined;
  return {
    ...(saved.length ? { saved_secrets: saved } : {}),
    ...(notSaved ? { secrets_not_saved: notSaved } : {}),
  };
}

// Read-only, masked fields only.
async function listLlmKeys() {
  const body = await apiGet("/v1/llm-keys");
  return {
    llm_keys: (body?.llm_keys ?? []).map((k: any) => ({
      id: k.id, name: k.name, provider: k.provider, masked: k.masked, base_url: k.base_url ?? null,
      is_default: !!k.is_default, status: k.status, status_detail: k.status_detail,
      status_message: k.status_message, last_validated_at: k.last_validated_at ?? null,
      last_used_at: k.last_used_at ?? null,
    })),
    limit: body?.limit,
    manage_at: LLM_KEYS_URL,
  };
}

// ── Robots ──────────────────────────────────────────────────────────────
// fetch directly, so the tools do not depend on the installed browsa SDK version.

const ROBOT_RUN_DONE = ["completed", "partial", "failed"];
const ROBOT_POLL_MS = Number(process.env.BROWSA_ROBOT_POLL_MS) || 3000;

function robotSummary(r: any) {
  const h = r?.health ?? {};
  const s = r?.schedule;
  const lr = r?.last_run;
  return {
    id: r?.id, name: r?.name, status: r?.status, paused_reason: r?.paused_reason ?? null,
    recipe_id: r?.recipe_id ?? null, inputs_count: r?.inputs_count ?? (Array.isArray(r?.inputs) ? r.inputs.length : 0),
    price_credits: h.price_credits ?? null, pass_rate: h.pass_rate ?? null, last_failure: h.last_failure ?? null,
    schedule: s ? { interval_seconds: s.interval_seconds, at: s.at ?? null, tz: s.tz ?? null, next_run_at: s.next_run_at ?? null, enabled: s.enabled } : null,
    settings: r?.settings ?? { model: null, proxy: null, browser: null },
    alerts_unread: r?.alerts_unread ?? 0,
    last_run: lr ? { id: lr.id, status: lr.status, rows_ok: lr.rows_ok, rows_failed: lr.rows_failed, credits: lr.credits, finished_at: lr.finished_at ?? null } : null,
  };
}

function robotRunView(run: any) {
  const out: Record<string, unknown> = {
    id: run?.id, robot_id: run?.robot_id, status: run?.status, trigger: run?.trigger,
    rows_total: run?.rows_total, rows_ok: run?.rows_ok, rows_failed: run?.rows_failed, rows_pending: run?.rows_pending,
    credits: run?.credits, stop_reason: run?.stop_reason ?? null, finished_at: run?.finished_at ?? null,
  };
  if (Array.isArray(run?.rows)) {
    out.rows = run.rows.map((r: any) => ({
      row: r.row, input: r.input, status: r.status, output: r.output ?? null,
      ...(r.error_code ? { error_code: r.error_code, error_message: r.error_message } : {}),
      credits: r.credits,
      ...(Array.isArray(r.changed_fields) && r.changed_fields.length ? { changed_fields: r.changed_fields } : {}),
    }));
  }
  return out;
}

async function runRobot(args: Record<string, any>) {
  const id = String(args.robot_id || "");
  if (!id) return fail("robot_id is required");
  const body: Record<string, unknown> = {};
  if (Array.isArray(args.inputs)) body.inputs = args.inputs;
  let run = await apiPost(`/v1/robots/${encodeURIComponent(id)}/run`, body, 30_000);
  const waitMs = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), 300) * 1000;
  const deadline = Date.now() + waitMs;
  while (waitMs > 0 && !ROBOT_RUN_DONE.includes(run?.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(ROBOT_POLL_MS, Math.max(0, deadline - Date.now()))));
    run = await apiGet(`/v1/robot-runs/${encodeURIComponent(run.id)}`);
  }
  return ok(robotRunView(run));
}

// ── Captcha API ─────────────────────────────────────────────────────────
// The calls themselves are in captcha/client.ts (fetch, so no dependency on the installed browsa SDK version).

const CAPTCHA_ALIASES: Record<string, [string, string]> = {
  recaptchav2taskproxyless: ["ReCaptchaV2TaskProxyLess", "ReCaptchaV2TaskProxyLess"],
  nocaptchataskproxyless: ["ReCaptchaV2TaskProxyLess", "ReCaptchaV2TaskProxyLess"],
  recaptchav2task: ["ReCaptchaV2TaskProxyLess", "ReCaptchaV2Task"],
  recaptchav2enterprisetaskproxyless: ["ReCaptchaV2EnterpriseTaskProxyLess", "ReCaptchaV2EnterpriseTaskProxyLess"],
  recaptchav2enterprisetask: ["ReCaptchaV2EnterpriseTaskProxyLess", "ReCaptchaV2EnterpriseTask"],
  recaptchav3taskproxyless: ["ReCaptchaV3TaskProxyLess", "ReCaptchaV3TaskProxyLess"],
  recaptchav3task: ["ReCaptchaV3TaskProxyLess", "ReCaptchaV3Task"],
  recaptchav3enterprisetaskproxyless: ["ReCaptchaV3EnterpriseTaskProxyLess", "ReCaptchaV3EnterpriseTaskProxyLess"],
  recaptchav3enterprisetask: ["ReCaptchaV3EnterpriseTaskProxyLess", "ReCaptchaV3EnterpriseTask"],
  turnstiletaskproxyless: ["AntiTurnstileTaskProxyLess", "AntiTurnstileTaskProxyLess"],
  antiturnstiletaskproxyless: ["AntiTurnstileTaskProxyLess", "AntiTurnstileTaskProxyLess"],
  turnstiletask: ["AntiTurnstileTaskProxyLess", "AntiTurnstileTask"],
  antiturnstiletask: ["AntiTurnstileTaskProxyLess", "AntiTurnstileTask"],
  imagetotexttask: ["ImageToTextTask", "ImageToTextTask"],
  recaptchav2classification: ["ReCaptchaV2Classification", "ReCaptchaV2Classification"],
};

async function solveCaptchaTask(args: Record<string, any>) {
  const task = { ...(args.task ?? {}) };
  if (typeof task.type !== "string" || !task.type) return fail("task.type is required");
  const pair = CAPTCHA_ALIASES[task.type.toLowerCase()];
  if (pair) task.type = task.proxy || task.proxyAddress ? pair[1] : pair[0];
  const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 180, 5), 600) * 1000;
  // The local limits (BROWSA_CAPTCHA_MAX_CREDITS and the others) cover this tool too; unset, nothing changes.
  const r = await guardedSolve(priceOf(task.type), async () => {
    const o = await runCaptchaTask(task, timeoutMs);
    return { credits: o.state === "solved" ? chargedCredits(o.body, task.type) : 0, value: o };
  });
  if ("refused" in r) return { isError: true, content: [{ type: "text" as const, text: r.refused.text }] };
  const o = r.value;
  if (o.state === "error") {
    const b = o.body;
    return fail(b.errorDescription || b.errorCode, {
      code: b.errorCode, task_id: b.taskId, charged: b.charged === true,
      ...(b.fix ? { fix: b.fix } : {}),
      ...(b.errorCode === "ERROR_TASK_NOT_SUPPORTED"
        ? { measured_types: "https://browsa.io/captcha", next: "call list_captcha_types for the type names and their parameters" } : {}),
    });
  }
  if (o.state === "timeout") {
    return fail(`no solution after ${Math.round(timeoutMs / 1000)}s; the task may still finish (charged only if solved)`,
      { code: "TIMEOUT", task_id: o.taskId });
  }
  return ok({
    task_id: o.taskId, type: task.type, solution: o.body.solution, seconds: o.seconds,
    ...(o.body.cost ? { cost: o.body.cost } : {}),
    next: "when the site has answered, call report_captcha_result with correct=true or correct=false",
  });
}

async function listCaptchaTypes(args: Record<string, any>) {
  const r = await captchaCall("types", null);
  if (r.errorId || !Array.isArray(r.types)) return fail(r.errorDescription || "the type catalogue is not available", { code: r.errorCode });
  const names = (ps: any[]) => (ps ?? []).map((p) => p.name);
  const measured = (t: any) => (t.measured ?? []).map((m: any) =>
    ({ what: m.name, passes: `${m.passes} of ${m.attempts}`, median_seconds: m.medianSeconds, measured_on: m.measuredOn, exit: m.exit }));
  if (typeof args.type === "string" && args.type) {
    const want = args.type.toLowerCase();
    const t = r.types.find((x: any) => String(x.type).toLowerCase() === want);
    if (!t) return fail(`no type named ${args.type}`, { types: r.types.map((x: any) => x.type) });
    return ok({ ...t, measured: measured(t) });
  }
  const types = r.types.filter((t: any) => !args.live_only || t.status === "live").map((t: any) => ({
    type: t.type, what: t.summary, status: t.status, ...(t.offReason ? { off_reason: t.offReason } : {}),
    required: [...names(t.required), ...(t.requiredOneOf ?? []).map((g: any[]) => names(g).join(" or "))],
    optional: names(t.optional), proxy: t.proxy,
    credits_per_solve: t.price?.creditsPerSolve, measured: measured(t),
  }));
  return ok({ types, note: "Names are case-sensitive. A failed solve is not charged. Pass `type` for one type's parameter descriptions." });
}

async function reportCaptchaResult(args: Record<string, any>) {
  if (typeof args.task_id !== "string" || !args.task_id) return fail("task_id is required");
  if (typeof args.correct !== "boolean") return fail("correct must be true or false");
  const r = await captchaCall(args.correct ? "reportCorrect" : "reportIncorrect", { taskId: args.task_id });
  if (r.errorId) {
    return fail(r.errorDescription || r.errorCode, { code: r.errorCode, task_id: args.task_id, ...(r.fix ? { fix: r.fix } : {}),
      ...(typeof r.refunded === "boolean" ? { refunded: r.refunded } : {}) });
  }
  return ok({ task_id: args.task_id, outcome: r.outcome, refunded: r.refunded === true, refund: r.refund, message: r.message });
}

export async function callLegacy(name: string, args: Record<string, any>) {
  let choice: LlmChoice | null = null;

  try {
    switch (name) {
      case "run_task": {
        choice = chooseLlm(args);
        // The "no key" answer comes from POST /v1/tasks, before any job
        // exists, so retrying runTask on the hosted model is safe.
        const { result: job, fellBack } = await submitWithHostedFallback(choice, (c) =>
          client.runTask({
            task: args.task,
            // Omitted fields are dropped from the request body.
            llm: c.llm as string,
            llmApiKey: c.llmApiKey,
            llmKeyId: c.llmKeyId,
            reasoning: args.reasoning,
            country: args.country ?? DEFAULT_COUNTRY,
            maxSteps: args.max_steps,
            initialUrl: args.initial_url,
            ja3Profile: args.ja3_profile,
            profileId: args.profile_id,
            // Sent as is (snake_case) and only when given.
            secret_ids: Array.isArray(args.secret_ids) && args.secret_ids.length ? args.secret_ids : undefined,
            save_secrets: typeof args.save_secrets === "boolean" ? args.save_secrets : undefined,
            timeoutMs: (args.timeout_minutes ?? 10) * 60_000,
          }),
        );
        return ok({
          ...(fellBack ? { note: HOSTED_FALLBACK_TASK_NOTE, llm: "browsa" } : {}),
          job_id: job.id,
          status: job.status,
          ...outcomeFields(job),
          steps: `${job.stepCount}/${job.progressTotal}`,
          live_url: job.liveUrl,
          credits_charged: job.creditsCharged,
          ...proxyUsage(job.raw),
          llm_key_masked: job.raw?.llm_key_masked,
          llm_key_source: job.raw?.llm_key_source,
          ...llmResultFields(job),
          ...savedSecretFields(job),
          final_result: job.finalResult,
          error: job.errorMessage,
          error_code: job.errorCode,
        });
      }
      case "get_job": {
        const job = await client.getJob(args.job_id, { wait: args.wait_seconds ?? 0 });
        return ok({
          job_id: job.id,
          status: job.status,
          ...outcomeFields(job),
          steps: `${job.stepCount}/${job.progressTotal}`,
          live_url: job.liveUrl,
          input_question: job.inputQuestion,
          ...llmResultFields(job),
          ...savedSecretFields(job),
          final_result: job.finalResult,
          error: job.errorMessage,
          error_code: job.errorCode,
          ...proxyUsage(job.raw),
        });
      }
      case "cancel_job": {
        await client.cancelJob(args.job_id);
        return ok({ cancelled: args.job_id });
      }
      case "respond_to_job": {
        const job = await client.respondToJob(args.job_id, args.response);
        return ok({ job_id: job.id, status: job.status });
      }
      case "start_browser": {
        const a = await client.createAgent({
          ttl: args.ttl ?? "10m",
          country: args.country ?? DEFAULT_COUNTRY,
          osType: args.os_type,
          agent_id: args.profile_id,
          proxy: args.proxy,
        });
        return ok({
          browser_id: a.id,
          status: a.status,
          // Connect a CDP client to cdp_http with the header
          // X-API-Key: <your key>; cdp_url is the page socket.
          cdp_http: a.cdp_http,
          cdp_url: a.cdp_url,
          live_url: a.live_url,
          expires_at: a.expires_at,
          credits_charged: a.cost_credits,
          ...proxyUsage(a),
          egress: args.proxy?.network ? `Browsa ${args.proxy.network} proxy network` : args.proxy ? "your proxy" : "Browsa's data-center IP",
          note: "Call stop_browser with this browser_id when you are done.",
        });
      }
      case "stop_browser":
        await client.destroyAgent(args.browser_id);
        return ok({ stopped: args.browser_id });
      case "list_browsers":
        return ok(await client.listIdentities());
      case "credits":
        return ok(await client.credits());
      case "list_webhooks":
        return ok(await client.listWebhooks());
      case "create_webhook":
        return ok(await client.createWebhook({ url: args.url, events: args.events }));
      case "delete_webhook":
        await client.deleteWebhook(args.webhook_id);
        return ok({ deleted: args.webhook_id });
      case "list_identities":
        // GET /v1/agents also lists recent burners (running, destroyed or
        // failed); only persistent identities can be passed as profile_id.
        return ok((await client.listIdentities()).filter((a) => a.mode === "persistent"));
      case "create_schedule": {
        choice = chooseLlm(args);
        const { result: s, fellBack } = await submitWithHostedFallback(choice, (c) =>
          client.createSchedule({
            name: args.name,
            task: args.task,
            llm: c.llm as string,
            llmApiKey: c.llmApiKey,
            llmKeyId: c.llmKeyId,
            reasoning: args.reasoning,
            intervalSeconds: args.interval_seconds,
            country: args.country ?? DEFAULT_COUNTRY,
            maxSteps: args.max_steps,
            initialUrl: args.initial_url,
          }),
        );
        return ok({
          ...(fellBack ? { note: HOSTED_FALLBACK_SCHEDULE_NOTE, llm: "browsa" } : {}),
          id: s.id, name: s.name, interval_seconds: s.intervalSeconds, enabled: s.enabled,
          next_run_at: s.nextRunAt, llm_key_id: s.raw?.llm_key_id,
        });
      }
      case "list_schedules":
        return ok(
          (await client.listSchedules()).map((s) => ({
            id: s.id, name: s.name, task: s.task, llm: s.llm, reasoning: s.raw?.reasoning ?? undefined,
            interval_seconds: s.intervalSeconds, enabled: s.enabled,
            next_run_at: s.nextRunAt, run_count: s.runCount,
          })),
        );
      case "list_job_files":
        return ok(await client.listJobFiles(args.job_id));
      case "list_llm_keys":
        return ok(await listLlmKeys());
      case "proxy_network":
        return ok(await proxyNetwork());
      case "list_models":
        return ok(await listModels());
      case "list_robots": {
        const lim = Number(args.limit) > 0 ? `?limit=${Math.floor(Number(args.limit))}` : "";
        const body = await apiGet(`/v1/robots${lim}`);
        return ok({ robots: (body?.robots ?? []).map(robotSummary) });
      }
      case "run_robot":
        return await runRobot(args);
      case "get_robot_run":
        if (!args.run_id) return fail("run_id is required");
        return ok(robotRunView(await apiGet(`/v1/robot-runs/${encodeURIComponent(String(args.run_id))}`)));
      case "solve_captcha_task":
        return await solveCaptchaTask(args);
      case "list_captcha_types":
        return await listCaptchaTypes(args);
      case "report_captcha_result":
        return await reportCaptchaResult(args);
      default:
        return fail(`unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof BrowsaError) {
      const keyErr = choice ? llmKeyError(e, choice) : null;
      if (keyErr) return keyErr;
      return fail(e.message, {
        code: e.code,
        status: e.status,
        request_id: e.requestId,
      });
    }
    return fail((e as Error).message || String(e));
  }
}
