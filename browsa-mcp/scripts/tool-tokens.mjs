#!/usr/bin/env node
// How much context each tool group costs: the size of the tools/list answer a
// client receives, per group, from the built server (run `npm run build` first).
//
// Tokens are an estimate: characters of the JSON tool definitions divided by 4.
// No tokenizer is used, so the figure is the same on every machine; real counts
// differ by model.
//
//   node scripts/tool-tokens.mjs            a table
//   node scripts/tool-tokens.mjs --json     the numbers
import { spawn } from "node:child_process";

const SERVER = new URL("../dist/server.js", import.meta.url).pathname;

function list(setting) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BROWSA_API_KEY: "", BROWSA_MCP_TOOLS: setting, BROWSA_CAPTCHA_CATALOGUE: "bundled" };
    const child = spawn("node", [SERVER], { env, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("no answer")); }, 10_000);
    child.stdout.on("data", (c) => {
      buf += c;
      for (const line of buf.split("\n")) {
        try {
          const m = JSON.parse(line);
          if (m.id === 2) { clearTimeout(timer); child.kill(); resolve(m.result.tools); }
        } catch { /* a partial line */ }
      }
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tokens", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });
}

const ROWS = [
  ["default (core)", ""],
  ["captcha_page only", "captcha_page,-core"],
  ["captcha only", "captcha,-core"],
  ["tasks only", "tasks,-core"],
  ["robots only", "robots,-core"],
  ["schedules only", "schedules,-core"],
  ["webhooks only", "webhooks,-core"],
  ["cdp only", "cdp,-core"],
  ["admin only", "admin,-core"],
  ["all", "all"],
];

const out = [];
for (const [label, setting] of ROWS) {
  const tools = await list(setting);
  const chars = JSON.stringify(tools).length;
  out.push({ label, setting, tools: tools.length, chars, tokens: Math.ceil(chars / 4) });
}
if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 1));
else {
  console.log("| Tools listed | BROWSA_MCP_TOOLS | Tools | Characters | Tokens (chars / 4) |\n|---|---|---|---|---|");
  for (const r of out) console.log(`| ${r.label} | ${r.setting ? `\`${r.setting}\`` : "(unset)"} | ${r.tools} | ${r.chars} | ${r.tokens} |`);
}
