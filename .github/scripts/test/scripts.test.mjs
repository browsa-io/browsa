// The release helpers: notes for a tag from the changelogs in this repository,
// and the trusted-publisher check against stand-ins for GitHub and npm.
//
//   node --test .github/scripts/test/scripts.test.mjs        (from the repository root)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { headingCovers, PACKAGES, parseTag, releaseNotes, sectionOf } from "../release-notes.mjs";
import { check, escapedName, howToFix } from "../npm-trusted-publisher-check.mjs";

// The repository root: two levels above .github/scripts/test in the public repo.
// In the private tree this file lives in sdks/public-github/scripts/test and the
// changelogs are laid out differently, so the tests that read them are skipped there.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const inPublicTree = existsSync(path.join(ROOT, "browsa-ts/package.json")) && existsSync(path.join(ROOT, "CHANGELOG.md"));
const json = (p) => JSON.parse(readFileSync(path.join(ROOT, p), "utf-8"));

test("parseTag knows every package tag and refuses the rest", () => {
  assert.deepEqual(parseTag("browsa-mcp-v0.8.1"), { key: "browsa-mcp", version: "0.8.1" });
  assert.deepEqual(parseTag("n8n-nodes-browsa-v0.1.2"), { key: "n8n-nodes-browsa", version: "0.1.2" });
  assert.deepEqual(parseTag("browsa-python-v0.7.1"), { key: "browsa-python", version: "0.7.1" });
  for (const bad of ["v0.3.2", "browsa-v1.0.0", "browsa-ts-0.7.1", "browsa-ts-vnext", "", undefined]) {
    assert.throws(() => parseTag(bad), /is not a package tag/);
  }
});

test("sectionOf takes one version's lines and stops at the next heading", () => {
  const log = "# Changelog\n\n## 0.2.0 (unreleased)\n\n- new\n\n## 0.1.10 (2026-01-02)\n\n- ten\n\n## 0.1.1 (2026-01-01)\n\n- one\n- two\n";
  assert.deepEqual(sectionOf(log, "0.1.1"), { heading: "0.1.1 (2026-01-01)", body: "- one\n- two" });
  assert.equal(sectionOf(log, "0.1.10").body, "- ten");            // 0.1.1 does not match 0.1.10
  assert.equal(sectionOf(log, "0.2.0").body, "- new");
  assert.equal(sectionOf(log, "0.3.0"), null);
});

test("a heading that names packages covers only those", () => {
  assert.equal(headingCovers("0.8.1 (`@browsa/mcp` only, 2026-11-21)", "browsa-mcp"), true);
  assert.equal(headingCovers("0.8.1 (`@browsa/mcp` only, 2026-11-21)", "browsa-ts"), false);
  assert.equal(headingCovers("0.7.1 (npm `browsa` and PyPI `browsa`, 2026-11-21)", "browsa-python"), true);
  assert.equal(headingCovers("0.7.1 (npm `browsa` and PyPI `browsa`, 2026-11-21)", "browsa-mcp"), false);
  assert.equal(headingCovers("0.7.0 (2026-11-21)", "browsa-mcp"), true);    // all three share the version
});

test("every package's current version has release notes in its changelog", { skip: !inPublicTree && "not the public repository layout" }, () => {
  const py = (p) => {
    const text = readFileSync(path.join(ROOT, p), "utf-8");
    return /^__version__\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  };
  const current = {
    "browsa-ts": json("browsa-ts/package.json").version,
    "browsa-mcp": json("browsa-mcp/package.json").version,
    "browsa-python": py("browsa-python/browsa/_version.py"),
    "n8n-nodes-browsa": json("integrations/n8n-nodes-browsa/package.json").version,
    "langchain-browsa": py("integrations/langchain-browsa/pyproject.toml"),
    "crewai-browsa": py("integrations/crewai-browsa/src/crewai_browsa/_version.py"),
  };
  assert.deepEqual(Object.keys(current).sort(), Object.keys(PACKAGES).sort());
  for (const [key, version] of Object.entries(current)) {
    assert.ok(version, `${key} has a version`);
    const r = releaseNotes(`${key}-v${version}`, ROOT);
    assert.equal(r.version, version);
    assert.ok(r.notes.length > 80, `${key} ${version} notes are not empty`);
    assert.ok(r.notes.includes(`tree/${key}-v${version}/`), "the notes link to the tagged source");
    assert.ok(!/chromium/i.test(r.title));
  }
});

test("release notes for the versions published before this workflow existed", { skip: !inPublicTree && "not the public repository layout" }, () => {
  const mcp = releaseNotes("browsa-mcp-v0.8.0", ROOT);
  assert.equal(mcp.title, "@browsa/mcp 0.8.0");
  assert.match(mcp.notes, /captcha_page/);
  assert.match(mcp.notes, /npx -y @browsa\/mcp@0\.8\.0/);
  assert.equal(releaseNotes("browsa-python-v0.7.0", ROOT).title, "browsa 0.7.0 (PyPI)");
  assert.equal(releaseNotes("browsa-ts-v0.7.0", ROOT).title, "browsa 0.7.0 (npm)");
  assert.throws(() => releaseNotes("browsa-ts-v0.8.0", ROOT), /is for another package/);
  assert.throws(() => releaseNotes("browsa-ts-v9.9.9", ROOT), /has no "## 9\.9\.9" section/);
});

// ── npm trusted publishing ──────────────────────────────────────────────

const env = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://gh.example/token?api-version=2", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "gh-bearer" };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the check offers GitHub's token to npm and passes on 2xx", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", auth: init.headers?.Authorization });
    return String(url).startsWith("https://gh.example") ? reply(200, { value: "id-token" }) : reply(201, { token: "npm-short-lived" });
  };
  assert.deepEqual(await check("@browsa/mcp", { env, fetchImpl }), { ok: true });
  assert.deepEqual(calls, [
    { url: "https://gh.example/token?api-version=2&audience=npm%3Aregistry.npmjs.org", method: "GET", auth: "Bearer gh-bearer" },
    { url: "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@browsa%2fmcp", method: "POST", auth: "Bearer id-token" },
  ]);
  assert.equal(escapedName("browsa"), "browsa");
});

test("a refused exchange is reported as not configured, with the form values", async () => {
  const fetchImpl = async (url) => (String(url).startsWith("https://gh.example")
    ? reply(200, { value: "id-token" }) : reply(404, { message: "OIDC token exchange error - package not found" }));
  const r = await check("browsa", { env, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "not-configured");
  assert.match(r.reason, /HTTP 404 \(OIDC token exchange error - package not found\)/);
  const fix = howToFix("browsa", "browsa-ts-publish.yml");
  for (const line of ["https://www.npmjs.com/package/browsa/access", "Organization or user: `browsa-io`", "Repository: `browsa`",
    "Workflow filename: `browsa-ts-publish.yml`", "Environment name: (leave empty)", "Nothing was published"]) {
    assert.ok(fix.includes(line), line);
  }
});

test("no OIDC token, or npm down, is not reported as a missing publisher", async () => {
  assert.equal((await check("browsa", { env: {}, fetchImpl: async () => reply(200, {}) })).kind, "no-oidc");
  const down = async (url) => (String(url).startsWith("https://gh.example") ? reply(200, { value: "t" }) : reply(503, {}));
  assert.equal((await check("browsa", { env, fetchImpl: down })).kind, "network");
});
