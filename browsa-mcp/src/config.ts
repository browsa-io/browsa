// Settings from the environment and the command line. Nothing here writes
// a file: the server keeps its state in memory only.

export const VERSION = "0.6.0";
export const API_KEY = process.env.BROWSA_API_KEY;
export const BASE_URL = (process.env.BROWSA_BASE_URL || "https://browsa.io").replace(/\/+$/, "");
export const BASE_URL_SET = !!process.env.BROWSA_BASE_URL;
export const DEFAULT_COUNTRY = process.env.BROWSA_COUNTRY || undefined;
export const KEYS_URL = "https://app.browsa.io/dashboard/keys";
export const NO_KEY_MESSAGE =
  "BROWSA_API_KEY is not set. Add it to this MCP server's env (mint one at " + KEYS_URL + "), then restart the server.";

// URL redaction can be switched off for debugging (BROWSA_MCP_REDACT=off).
export const REDACT = !/^(0|off|false|no)$/i.test(process.env.BROWSA_MCP_REDACT ?? "");

// ── Tool groups ─────────────────────────────────────────────────────────
// The nine core tools are always on. Everything else is in a group, turned
// on with BROWSA_MCP_TOOLS=robots,tasks,admin (or --tools=...). "all" turns
// on every group: the full 0.5 tool set plus the core tools.

export const GROUPS: Record<string, string[]> = {
  tasks: ["run_task", "get_job", "cancel_job", "respond_to_job", "list_job_files"],
  robots: ["list_robots", "run_robot", "get_robot_run"],
  schedules: ["create_schedule", "list_schedules"],
  webhooks: ["list_webhooks", "create_webhook", "delete_webhook"],
  cdp: ["start_browser", "stop_browser"],
  captcha: ["solve_captcha_task"],
  admin: ["credits", "list_browsers", "list_identities", "proxy_network", "list_llm_keys", "list_models"],
};

export const CORE_TOOLS = ["open", "observe", "act", "read", "screenshot", "secrets", "handoff", "flow", "close"];

function toolsSetting(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--tools=")) return a.slice("--tools=".length);
    if (a === "--tools" && i + 1 < argv.length) return argv[i + 1];
  }
  return process.env.BROWSA_MCP_TOOLS ?? "";
}

/** The optional tools to list, from the setting; unknown words are reported. */
export function enabledExtras(setting = toolsSetting(process.argv.slice(2))): { tools: Set<string>; unknown: string[] } {
  const tools = new Set<string>();
  const unknown: string[] = [];
  const all = Object.values(GROUPS).flat();
  for (const raw of setting.split(/[,\s]+/)) {
    const w = raw.trim().toLowerCase();
    if (!w || w === "core") continue;
    if (w === "all") all.forEach((t) => tools.add(t));
    else if (GROUPS[w]) GROUPS[w].forEach((t) => tools.add(t));
    else if (all.includes(w)) tools.add(w); // one tool by name
    else unknown.push(raw.trim());
  }
  return { tools, unknown };
}
