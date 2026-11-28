// Settings from the environment and the command line. Nothing here writes
// a file: the server keeps its state in memory only.

export const VERSION = "0.8.3";
/** What every call to Browsa says it is (the API counts calls per client and version). */
export const USER_AGENT = `browsa-mcp/${VERSION}`;
// Install forms pass optional settings as empty strings: empty means unset.
export const API_KEY = process.env.BROWSA_API_KEY?.trim() || undefined;
export const BASE_URL = (process.env.BROWSA_BASE_URL || "https://browsa.io").replace(/\/+$/, "");
export const BASE_URL_SET = !!process.env.BROWSA_BASE_URL;
export const DEFAULT_COUNTRY = process.env.BROWSA_COUNTRY || undefined;
export const KEYS_URL = "https://app.browsa.io/dashboard/keys";
export const NO_KEY_MESSAGE =
  "BROWSA_API_KEY is not set. Create a key at " + KEYS_URL + ", add it to this MCP server's env, then restart the server.";

/** `--help` / `-h` or `--version` / `-v` on the command line: print and exit, do not start the server. */
export function cliFlag(argv: string[] = process.argv.slice(2)): "help" | "version" | undefined {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  if (argv.includes("--version") || argv.includes("-v") || argv.includes("-V")) return "version";
  return undefined;
}

export const HELP = `browsa-mcp ${VERSION}: MCP server for Browsa (stdio)

Cloud browsers (Phantom) for an MCP client, and captcha solving for a browser of your own.
An MCP client starts this command; it speaks MCP on stdin and stdout.

Usage:
  npx -y @browsa/mcp [--tools=<groups>]
  npx -y @browsa/mcp --help | --version

Options:
  --tools=<groups>   Optional tool groups, comma separated (same as BROWSA_MCP_TOOLS):
                     tasks, robots, schedules, webhooks, cdp, captcha, captcha_page, admin, or all.
                     -name takes a group or a tool off; -core takes the nine core tools off.
  -h, --help         Print this and exit
  -v, --version      Print the version and exit

Environment:
  BROWSA_API_KEY                  Your Browsa API key. Create a key at ${KEYS_URL}
                                  Without it the tools are listed; detect_captcha, captcha_allowance
                                  and list_captcha_types still answer.
  BROWSA_MCP_TOOLS                Optional tool groups, as --tools
  BROWSA_BASE_URL                 Default https://browsa.io
  BROWSA_COUNTRY                  Default exit country for open
  BROWSA_LLM, BROWSA_LLM_KEY_ID, BROWSA_LLM_API_KEY     Model settings for the tasks group
  BROWSA_CAPTCHA_URL              Default https://captcha.browsa.io
  BROWSA_CAPTCHA_MAX_CREDITS, BROWSA_CAPTCHA_RATE_PER_MINUTE, BROWSA_CAPTCHA_CONCURRENCY
                                  Local limits for captcha solves (off unless set)
  BROWSA_MCP_RETRIES              Default 2; 0 for none
  BROWSA_MCP_REDACT=off           Show URL tokens (debugging only)

Core tools (on by default): open, observe, act, read, screenshot, secrets, handoff, flow, close

Docs: https://browsa.io/guides/mcp-server
Source: https://github.com/browsa-io/browsa/tree/main/browsa-mcp
`;

/** What the server tells a client about itself at initialize (MCP "instructions"). */
export const INSTRUCTIONS =
  "Browsa gives you a real cloud browser (Phantom) and, for a browser of your own, captcha solving. " +
  "Browser tools: open a page, observe it as text (one line per element with an id), act on an id, read a container, " +
  "and close the browser when done; a browser left open keeps running until its ttl. " +
  "act answers with a status on its first line and, when something stopped, a `next:` line: follow it. " +
  "Type saved secrets with act secret (their values never reach you); call handoff when a person has to step in. " +
  "Opening a browser, tasks, robots and captcha solves spend the workspace's credits; reads and lists are free. " +
  "Tools that are not listed are in optional groups: the error names the BROWSA_MCP_TOOLS setting that turns one on. " +
  "Without BROWSA_API_KEY only detect_captcha, captcha_allowance and list_captcha_types answer.";

// URL redaction can be switched off for debugging (BROWSA_MCP_REDACT=off).
export const REDACT = !/^(0|off|false|no)$/i.test(process.env.BROWSA_MCP_REDACT ?? "");

// ── Tool groups ─────────────────────────────────────────────────────────
// The nine core tools are on unless "-core" is given. Everything else is in a
// group, turned on with BROWSA_MCP_TOOLS=robots,tasks,admin (or --tools=...).
// "all" turns on every group. A word with a leading "-" takes a group or a
// tool off again: "captcha_page,-core" lists only the captcha tools for a
// browser of your own.

export const GROUPS: Record<string, string[]> = {
  tasks: ["run_task", "get_job", "cancel_job", "respond_to_job", "list_job_files"],
  robots: ["list_robots", "run_robot", "get_robot_run"],
  schedules: ["create_schedule", "list_schedules"],
  webhooks: ["list_webhooks", "create_webhook", "delete_webhook"],
  cdp: ["start_browser", "stop_browser"],
  captcha: ["solve_captcha_task", "list_captcha_types", "report_captcha_result"],
  captcha_page: ["detect_captcha", "solve_captcha_on_page", "captcha_allowance"],
  admin: ["credits", "list_browsers", "list_identities", "proxy_network", "list_llm_keys", "list_models"],
};

export const CORE_TOOLS = ["open", "observe", "act", "read", "screenshot", "secrets", "handoff", "flow", "close"];

/** Tools that run without an API key: they call nothing, or only public addresses. */
export const NO_KEY_TOOLS = ["detect_captcha", "captcha_allowance", "list_captcha_types"];

function toolsSetting(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--tools=")) return a.slice("--tools=".length);
    if (a === "--tools" && i + 1 < argv.length) return argv[i + 1];
  }
  return process.env.BROWSA_MCP_TOOLS ?? "";
}

/**
 * The tools to list, from the setting; unknown words are reported.
 * `tools` are the optional ones, `core` the core ones still on.
 */
export function enabledExtras(setting = toolsSetting(process.argv.slice(2))): { tools: Set<string>; core: Set<string>; unknown: string[] } {
  const tools = new Set<string>();
  const core = new Set<string>(CORE_TOOLS);
  const unknown: string[] = [];
  const all = Object.values(GROUPS).flat();
  const words = setting.split(/[,\s]+/).map((w) => w.trim()).filter(Boolean);
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (w.startsWith("-") || w === "core") continue;
    if (w === "all") all.forEach((t) => tools.add(t));
    else if (GROUPS[w]) GROUPS[w].forEach((t) => tools.add(t));
    else if (all.includes(w)) tools.add(w); // one tool by name
    else if (!CORE_TOOLS.includes(w)) unknown.push(raw);
  }
  // removals last, so their place in the list does not matter
  for (const raw of words) {
    if (!raw.startsWith("-")) continue;
    const w = raw.slice(1).toLowerCase();
    if (w === "core") core.clear();
    else if (GROUPS[w]) GROUPS[w].forEach((t) => tools.delete(t));
    else if (all.includes(w)) tools.delete(w);
    else if (CORE_TOOLS.includes(w)) core.delete(w);
    else unknown.push(raw);
  }
  return { tools, core, unknown };
}

// ── Numbers from the environment ────────────────────────────────────────

/** A number from an env var; unset, empty or not a number gives `fallback`. */
export function numEnv(name: string, fallback: number | null, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}
