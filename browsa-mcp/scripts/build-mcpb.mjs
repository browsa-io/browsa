#!/usr/bin/env node
// Stages an MCP Bundle (.mcpb, the open one-file install format for desktop
// MCP clients) in build/mcpb: manifest.json, README, LICENSE and one
// self-contained dist/server.js with its dependencies inside, so the client
// needs no npm install.
//
//   node scripts/build-mcpb.mjs
//   npx @anthropic-ai/mcpb validate build/mcpb/manifest.json
//   npx @anthropic-ai/mcpb pack build/mcpb build/browsa.mcpb
//
// Nothing here publishes anything.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "tsup";

const root = new URL("..", import.meta.url).pathname;
const out = `${root}build/mcpb`;
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
const manifest = JSON.parse(readFileSync(`${root}manifest.json`, "utf8"));
if (manifest.version !== pkg.version) throw new Error(`manifest.json is ${manifest.version}, package.json is ${pkg.version}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entry: [`${root}src/server.ts`], format: ["esm"], target: "node18", outDir: `${out}/dist`,
  noExternal: [/.*/], shims: true, clean: true, silent: true,
  // dependencies written for CommonJS call require() for Node's own modules
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
for (const f of ["manifest.json", "README.md", "LICENSE"]) cpSync(`${root}${f}`, `${out}/${f}`);
// dist/server.js is an ES module: without this file Node reads it as CommonJS and the server does not start
writeFileSync(`${out}/package.json`, JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module" }, null, 2) + "\n");
console.log(`staged ${out} (version ${pkg.version})`);
