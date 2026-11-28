// Every call to Browsa says it is browsa-mcp and which version (the API
// counts calls per client and version; a bare "browsa-mcp" hides the version).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
}

test("config: USER_AGENT is browsa-mcp/<package version>", () => {
  const cfg = fs.readFileSync(path.join(SRC, "config.ts"), "utf8");
  assert.ok(cfg.includes(`export const VERSION = "${pkg.version}";`), "VERSION matches package.json");
  assert.ok(cfg.includes("export const USER_AGENT = `browsa-mcp/${VERSION}`;"));
});

test("no request sends a User-Agent without the version", () => {
  let seen = 0;
  for (const f of files(SRC)) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/"User-Agent":\s*([^,}\n]+)/gi)) {
      seen++;
      assert.match(m[1].trim(), /^(USER_AGENT|CAPTCHA_UA)$/, `${path.basename(f)}: User-Agent ${m[1]}`);
    }
  }
  assert.ok(seen >= 4, "the request headers were found");
  const cap = fs.readFileSync(path.join(SRC, "captcha", "client.ts"), "utf8");
  assert.ok(cap.includes("const CAPTCHA_UA = `${USER_AGENT} (captcha)`;"));
});
