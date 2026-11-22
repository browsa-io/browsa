#!/usr/bin/env node
/**
 * MCP server for Browsa: real cloud browsers (Phantom) for any MCP client,
 * and captcha solving for a browser of your own.
 *
 * Nine core tools are on by default: open, observe, act, read, screenshot,
 * secrets, handoff, flow, close. Everything else is an optional group:
 *
 *   BROWSA_MCP_TOOLS=robots,tasks,admin     or the argument --tools=robots,tasks
 *   BROWSA_MCP_TOOLS=all                    every group, plus the core tools
 *   BROWSA_MCP_TOOLS=captcha_page,-core     only the captcha tools for your own browser
 *
 * Required env: BROWSA_API_KEY (detect_captcha runs without it). Optional:
 * BROWSA_BASE_URL, BROWSA_COUNTRY, BROWSA_LLM, BROWSA_LLM_KEY_ID,
 * BROWSA_LLM_API_KEY (tasks group), BROWSA_CAPTCHA_URL, BROWSA_CAPTCHA_MAX_CREDITS,
 * BROWSA_CAPTCHA_RATE_PER_MINUTE, BROWSA_CAPTCHA_CONCURRENCY, BROWSA_CAPTCHA_CATALOGUE
 * (captcha groups), BROWSA_MCP_RETRIES, BROWSA_MCP_REDACT=off.
 *
 * Starting makes no request that the server waits for: the tool list is built
 * in, and the captcha type list starts from a copy bundled with the package.
 * The server writes no files: state (open browsers, view sessions, a flow
 * being recorded, captcha spend) is kept in memory. Tokens in URLs are masked
 * in every answer, and secrets are typed by Browsa from a reference: their
 * values never pass through this process.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { refreshCatalogue } from "./captcha/catalogue.js";
import { callCaptchaPage, CAPTCHA_PAGE_TOOLS, captchaPageTools, setReportToolListed } from "./captcha/tools.js";
import { annotate } from "./annotations.js";
import {
  API_KEY, cliFlag, CORE_TOOLS, enabledExtras, GROUPS, HELP, INSTRUCTIONS, KEYS_URL, NO_KEY_MESSAGE, NO_KEY_TOOLS, REDACT, VERSION,
} from "./config.js";
import { callCore, coreTools } from "./core.js";
import { callLegacy, legacyTools } from "./legacy.js";
import { getPrompt, listPrompts } from "./prompts.js";
import { redactUrls } from "./redact.js";

// --help and --version print and exit: nothing below starts, no key is needed.
const FLAG = cliFlag();

// Without a key the server still starts and lists its tools, so MCP clients and
// directories can introspect it; every tool call then answers NO_KEY_MESSAGE.
if (!FLAG && !API_KEY) {
  console.error("[browsa-mcp] BROWSA_API_KEY is not set: tools are listed, but calls that reach Browsa will fail until it is.");
  console.error(`           Create a key at ${KEYS_URL}`);
}

const extras = enabledExtras();
for (const w of FLAG ? [] : extras.unknown) {
  console.error(`[browsa-mcp] BROWSA_MCP_TOOLS: unknown group or tool "${w}" (groups: ${Object.keys(GROUPS).join(", ")}, all)`);
}

// Every tool carries annotations (read-only / destructive hints): src/annotations.ts.
const tools = [
  ...coreTools.filter((t) => extras.core.has(t.name)),
  ...captchaPageTools.filter((t) => extras.tools.has(t.name)),
  ...legacyTools.filter((t) => extras.tools.has(t.name)),
].map((t) => annotate(t));
const listed = new Set<string>(tools.map((t) => t.name));
setReportToolListed(listed.has("report_captcha_result"));

const server = new Server(
  { name: "browsa", title: "Browsa", version: VERSION },
  { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts(listed) }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const p = getPrompt(req.params.name, (req.params.arguments ?? {}) as Record<string, string>, listed);
  if (!p) throw new Error(`unknown prompt: ${req.params.name}`);
  return p;
});

const clean = (s: string) => (REDACT ? redactUrls(s) : s);

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  if (!listed.has(name)) {
    const group = Object.entries(GROUPS).find(([, t]) => t.includes(name))?.[0];
    const text = group
      ? `error: ${name} is in the optional group "${group}"\nnext: set BROWSA_MCP_TOOLS=${group} (or all) in this server's env and restart it`
      : CORE_TOOLS.includes(name)
        ? `error: ${name} is a core tool and the core tools are switched off\nnext: take "-core" out of BROWSA_MCP_TOOLS in this server's env and restart it`
        : `error: unknown tool ${name}`;
    return { isError: true, content: [{ type: "text" as const, text }] };
  }
  if (!API_KEY && !NO_KEY_TOOLS.includes(name)) return { isError: true, content: [{ type: "text" as const, text: NO_KEY_MESSAGE }] };

  if (CAPTCHA_PAGE_TOOLS.includes(name)) {
    const r = await callCaptchaPage(name, args);
    return { ...(r.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: clean(r.text) }] };
  }

  if (CORE_TOOLS.includes(name)) {
    const r = await callCore(name, args);
    const content: any[] = [];
    if (r.image) content.push({ type: "image", data: r.image.data, mimeType: r.image.mime });
    content.push({ type: "text", text: clean(r.text) });
    return { ...(r.isError ? { isError: true } : {}), content };
  }
  const r: any = await callLegacy(name, args);
  for (const c of r.content ?? []) if (c.type === "text") c.text = clean(c.text);
  return r;
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The live captcha type list, when a captcha tool is on: one public GET with no key and no parameters,
  // not waited for. Offline, the bundled list stays.
  if (GROUPS.captcha_page.some((t) => listed.has(t))) void refreshCatalogue();
  // Log to STDERR: MCP stdio uses STDOUT for protocol frames.
  console.error(`[browsa-mcp] ${VERSION} ready (tools=${tools.length})`);
}

if (FLAG === "version") {
  console.log(VERSION);
} else if (FLAG === "help") {
  console.log(HELP);
} else {
  main().catch((e) => {
    console.error("[browsa-mcp] fatal:", e);
    process.exit(1);
  });
}
