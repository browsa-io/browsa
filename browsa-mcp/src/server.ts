#!/usr/bin/env node
/**
 * MCP server for Browsa: real cloud browsers (Phantom) for any MCP client.
 *
 * Nine core tools are on by default: open, observe, act, read, screenshot,
 * secrets, handoff, flow, close. The 0.5 tools (tasks, robots, schedules,
 * webhooks, CDP browsers, the captcha API, account tools) are optional
 * groups:
 *
 *   BROWSA_MCP_TOOLS=robots,tasks,admin     or the argument --tools=robots,tasks
 *   BROWSA_MCP_TOOLS=all                    every 0.5 tool, plus the core tools
 *
 * Required env: BROWSA_API_KEY. Optional: BROWSA_BASE_URL, BROWSA_COUNTRY,
 * BROWSA_LLM, BROWSA_LLM_KEY_ID, BROWSA_LLM_API_KEY (tasks group),
 * BROWSA_CAPTCHA_URL (captcha group), BROWSA_MCP_REDACT=off.
 *
 * The server writes no files: state (open browsers, view sessions, a flow
 * being recorded) is kept in memory. Tokens in URLs are masked in every
 * answer, and secrets are typed by Browsa from a reference: their values
 * never pass through this process.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { API_KEY, CORE_TOOLS, enabledExtras, GROUPS, KEYS_URL, NO_KEY_MESSAGE, REDACT, VERSION } from "./config.js";
import { callCore, coreTools } from "./core.js";
import { callLegacy, legacyTools } from "./legacy.js";
import { redactUrls } from "./redact.js";

// Without a key the server still starts and lists its tools, so MCP clients and
// directories can introspect it; every tool call then answers NO_KEY_MESSAGE.
if (!API_KEY) {
  console.error("[browsa-mcp] BROWSA_API_KEY is not set: tools are listed, but every call will fail until it is.");
  console.error(`           Mint one at ${KEYS_URL}`);
}

const extras = enabledExtras();
for (const w of extras.unknown) {
  console.error(`[browsa-mcp] BROWSA_MCP_TOOLS: unknown group or tool "${w}" (groups: ${Object.keys(GROUPS).join(", ")}, all)`);
}

const tools = [...coreTools, ...legacyTools.filter((t) => extras.tools.has(t.name))];
const listed = new Set(tools.map((t) => t.name));

const server = new Server({ name: "browsa", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

const clean = (s: string) => (REDACT ? redactUrls(s) : s);

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  if (!listed.has(name)) {
    const group = Object.entries(GROUPS).find(([, t]) => t.includes(name))?.[0];
    const text = group
      ? `error: ${name} is in the optional group "${group}"\nnext: set BROWSA_MCP_TOOLS=${group} (or all) in this server's env and restart it`
      : `error: unknown tool ${name}`;
    return { isError: true, content: [{ type: "text" as const, text }] };
  }
  if (!API_KEY) return { isError: true, content: [{ type: "text" as const, text: NO_KEY_MESSAGE }] };

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
  // Log to STDERR: MCP stdio uses STDOUT for protocol frames.
  console.error(`[browsa-mcp] ${VERSION} ready (tools=${tools.length})`);
}

main().catch((e) => {
  console.error("[browsa-mcp] fatal:", e);
  process.exit(1);
});
