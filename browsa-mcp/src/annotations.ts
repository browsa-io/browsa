// Tool annotations (MCP `annotations`): what a client may assume about a tool
// before it asks the person. One row per tool, in one place, so a new tool
// cannot ship without one (a test compares this table with the tool lists).
//
//   readOnlyHint     the tool changes nothing and spends nothing
//   destructiveHint  the tool can change or remove something that is not undone
//                    by calling it again: an action on a website, a stopped
//                    browser, a deleted webhook
//   idempotentHint   calling it again with the same arguments changes nothing more
//   openWorldHint    false for the tools that run inside this process only
//
// The hints are stated conservatively: a tool that acts on a page (act, flow,
// run_task, run_robot) is marked destructive because the page decides what a
// click does.

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

const read = (title: string, extra: Partial<ToolAnnotations> = {}): ToolAnnotations =>
  ({ title, readOnlyHint: true, destructiveHint: false, ...extra });
const write = (title: string, extra: Partial<ToolAnnotations> = {}): ToolAnnotations =>
  ({ title, readOnlyHint: false, destructiveHint: false, ...extra });
const destructive = (title: string, extra: Partial<ToolAnnotations> = {}): ToolAnnotations =>
  ({ title, readOnlyHint: false, destructiveHint: true, ...extra });

export const ANNOTATIONS: Record<string, ToolAnnotations> = {
  // core
  open: write("Open a browser"),
  observe: read("Read the page as text"),
  act: destructive("Act on the page"),
  read: read("Read a container"),
  screenshot: read("Take a screenshot"),
  secrets: read("List saved secrets"),
  handoff: write("Hand over to a person"),
  flow: destructive("Record or replay a flow"),
  close: destructive("Close the browser", { idempotentHint: true }),
  // tasks
  run_task: destructive("Run an agent task"),
  get_job: read("Get a job"),
  cancel_job: destructive("Cancel a job", { idempotentHint: true }),
  respond_to_job: write("Answer a job's question"),
  list_job_files: read("List a job's files"),
  // robots
  list_robots: read("List robots"),
  run_robot: destructive("Run a robot"),
  get_robot_run: read("Get a robot run"),
  // schedules
  create_schedule: write("Create a schedule"),
  list_schedules: read("List schedules"),
  // webhooks
  list_webhooks: read("List webhooks"),
  create_webhook: write("Create a webhook"),
  delete_webhook: destructive("Delete a webhook", { idempotentHint: true }),
  // cdp
  start_browser: write("Start a browser for CDP"),
  stop_browser: destructive("Stop a browser", { idempotentHint: true }),
  // captcha
  solve_captcha_task: write("Solve a captcha task"),
  list_captcha_types: read("List captcha types"),
  report_captcha_result: write("Report a captcha result"),
  // captcha_page
  detect_captcha: read("Find the captcha in a page", { idempotentHint: true, openWorldHint: false }),
  solve_captcha_on_page: write("Solve a captcha for your browser"),
  captcha_allowance: read("Captcha allowance left", { openWorldHint: false }),
  // admin
  credits: read("Credit balance"),
  list_browsers: read("List browsers"),
  list_identities: read("List identities"),
  proxy_network: read("Proxy network"),
  list_llm_keys: read("List saved LLM keys"),
  list_models: read("List models"),
};

/** The tool with its annotations attached. A tool without a row is refused at startup. */
export function annotate<T extends { name: string }>(tool: T): T & { annotations: ToolAnnotations } {
  const a = ANNOTATIONS[tool.name];
  if (!a) throw new Error(`tool ${tool.name} has no annotations (src/annotations.ts)`);
  return { ...tool, annotations: a };
}
