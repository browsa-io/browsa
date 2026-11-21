// Built-in prompts: short recipes a person picks in the client. Each is listed
// only when the tools it names are on, so a prompt never points at a tool the
// client cannot call. Prompts are fetched on demand: they add nothing to the
// tool list.

interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
  needs: string[];
  text: (args: Record<string, string>) => string;
}

const PROMPTS: PromptDef[] = [
  {
    name: "solve_captcha_on_my_page",
    title: "Solve the captcha on my current page",
    description: "For a browser of your own: detect the captcha, solve it, apply the answer, verify.",
    arguments: [{ name: "url", description: "The page, when it is not the one already open." }],
    needs: ["detect_captcha", "solve_captcha_on_page"],
    text: (a) => [
      `Solve the captcha on ${a.url ? `the page ${a.url}` : "the page that is open in my browser"}, using my own browser tools for the page and Browsa's tools for the captcha.`,
      "",
      "1. Detect. With my browser tools, read the page's address, its HTML (document.documentElement.outerHTML) and the URLs of its frames and scripts. Call detect_captcha with html, url and resources. It runs locally and is free.",
      "2. Decide. Take the entry with ready true. If none is ready, tell me what its missing list asks for, or that the type is not in the catalogue, and stop. An entry with solve_with solve_captcha_task is a picture puzzle: this recipe does not cover it.",
      "3. Solve. Call solve_captcha_on_page with that entry as captcha (add proxy when the entry asks for one). Note cost in the answer. On a refusal with code LOCAL_LIMIT, wait retry_after_seconds, or stop when it is null.",
      "4. Apply. Do apply.steps in my browser: evaluate apply.expression in the page's main frame, or set apply.cookies and request the page again. Do not reload the page between solving and applying.",
      "5. Verify. Read the page again: say whether the site accepted the answer, quoting what the page shows. If it refused, solve once more at most, then stop and tell me.",
      "",
      "Report: the captcha type, whether the site accepted it, the credits it cost, and the allowance left.",
    ].join("\n"),
  },
  {
    name: "what_captcha_is_this",
    title: "What captcha is on this page?",
    description: "Detect only: which captcha a page has, and whether Browsa's captcha API takes it. Free.",
    arguments: [{ name: "url", description: "The page, when it is not the one already open." }],
    needs: ["detect_captcha"],
    text: (a) => [
      `Tell me which captcha is on ${a.url ? `the page ${a.url}` : "the page that is open in my browser"}. Solve nothing and spend nothing.`,
      "",
      "With my browser tools, read the page's address, its HTML and the URLs of its frames and scripts, then call detect_captcha with html, url and resources.",
      "For each entry say: the provider's name, the task type, its status in the catalogue, the price per solve, what is missing, and how sure the detection is (confidence, evidence). If nothing is found, say so and say that a widget inside a frame only shows through its frame URL.",
    ].join("\n"),
  },
  {
    name: "pass_check_in_browsa_browser",
    title: "Get past a check in a Browsa browser",
    description: "For a Browsa cloud browser: open the page, solve the check in place, hand over to a person if it stays.",
    arguments: [{ name: "url", description: "The page to open.", required: true }],
    needs: ["open", "act", "observe", "handoff"],
    text: (a) => [
      `Open ${a.url || "the page"} in a Browsa browser and get to its real content.`,
      "",
      "1. open the url. Read the first view.",
      "2. If an act or observe answer starts with challenge, call act with action solve_captcha once, then observe.",
      "3. If the check is still there, call handoff with the reason and give me the link; continue when the next observe says the page moved on.",
      "4. Tell me what the page shows now, then close the browser unless I asked to keep it.",
    ].join("\n"),
  },
];

export function listPrompts(listed: Set<string>) {
  return PROMPTS.filter((p) => p.needs.every((t) => listed.has(t)))
    .map(({ name, title, description, arguments: args }) => ({ name, title, description, ...(args ? { arguments: args } : {}) }));
}

export function getPrompt(name: string, args: Record<string, string>, listed: Set<string>) {
  const p = PROMPTS.find((x) => x.name === name && x.needs.every((t) => listed.has(t)));
  if (!p) return null;
  return {
    description: p.description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text: p.text(args ?? {}) } }],
  };
}
