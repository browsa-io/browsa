#!/usr/bin/env node
// Fail fast, with the fix, when npm trusted publishing is not set up for a
// package. Run at the start of a publish workflow, before install and tests:
//
//   node .github/scripts/npm-trusted-publisher-check.mjs <package> <workflow-file>
//
// It asks GitHub for the job's OIDC token and offers it to npm, the same
// exchange `npm publish` makes. npm answers 2xx only when the package has a
// Trusted Publisher that matches this repository and workflow file. Nothing
// is published and the short-lived token npm returns is thrown away.
//
// Without this check the first sign is `npm error code E404 ... is not in this
// registry` at the very end of the run, which says nothing about the cause.
import { fileURLToPath } from "node:url";
import path from "node:path";

const REGISTRY = "https://registry.npmjs.org";

/** npm's escaped package name: "@scope/name" -> "@scope%2fname". */
export const escapedName = (name) => (name.startsWith("@") ? name.replace("/", "%2f") : name);

/** The settings page and the exact form values, as text for the job log and summary. */
export function howToFix(pkg, workflow, repository = "browsa-io/browsa", environment = "") {
  const [owner, repo] = repository.split("/");
  return [
    `npm has no Trusted Publisher for \`${pkg}\` that matches this workflow, so this run cannot publish.`,
    "",
    `Set it once at https://www.npmjs.com/package/${pkg}/access (Settings > Trusted Publisher > GitHub Actions):`,
    "",
    `- Organization or user: \`${owner}\``,
    `- Repository: \`${repo}\``,
    `- Workflow filename: \`${workflow}\``,
    `- Environment name: ${environment ? `\`${environment}\`` : "(leave empty)"}`,
    "",
    "Then re-run this job. Nothing was published and nothing needs to be deleted.",
    "Until it is set, the package can be published by hand with `npm publish` from a clean checkout of this tag.",
  ].join("\n");
}

/**
 * {ok: true} when npm accepts this job's OIDC token for `pkg`; otherwise {ok: false, reason}.
 * `env` and `fetchImpl` are parameters so a test can stand in for GitHub and npm.
 */
export async function check(pkg, { env = process.env, fetchImpl = fetch, registry = REGISTRY } = {}) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    return { ok: false, kind: "no-oidc", reason: "This job has no OIDC token: it needs `permissions: id-token: write` and must run on GitHub Actions." };
  }
  let idToken;
  try {
    const r = await fetchImpl(`${url}${url.includes("?") ? "&" : "?"}audience=${encodeURIComponent(`npm:${new URL(registry).hostname}`)}`,
      { headers: { Authorization: `Bearer ${bearer}` } });
    idToken = (await r.json()).value;
    if (!r.ok || !idToken) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    return { ok: false, kind: "no-oidc", reason: `GitHub did not issue an OIDC token (${e.message}).` };
  }
  let r;
  try {
    r = await fetchImpl(`${registry}/-/npm/v1/oidc/token/exchange/package/${escapedName(pkg)}`,
      { method: "POST", headers: { Authorization: `Bearer ${idToken}`, Accept: "application/json" } });
  } catch (e) {
    return { ok: false, kind: "network", reason: `npm could not be reached (${e.message}).` };
  }
  if (r.ok) return { ok: true };
  let message = "";
  try { message = (await r.json()).message ?? ""; } catch { /* not JSON */ }
  if (r.status >= 500) return { ok: false, kind: "network", reason: `npm answered HTTP ${r.status} to the token exchange. Re-run the job.` };
  return { ok: false, kind: "not-configured", reason: `npm refused the token exchange: HTTP ${r.status}${message ? ` (${message})` : ""}.` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [pkg, workflow, environment = ""] = process.argv.slice(2);
  if (!pkg || !workflow) {
    console.error("usage: npm-trusted-publisher-check.mjs <package> <workflow-file> [environment]");
    process.exit(2);
  }
  const res = await check(pkg);
  if (res.ok) {
    console.log(`npm accepts this workflow as a Trusted Publisher of ${pkg}.`);
  } else {
    const fix = res.kind === "not-configured" ? howToFix(pkg, workflow, process.env.GITHUB_REPOSITORY || "browsa-io/browsa", environment) : "";
    const title = res.kind === "not-configured" ? `npm trusted publishing is not configured for ${pkg}` : `Cannot check npm trusted publishing for ${pkg}`;
    // One annotation (shown on the run page) and the full text in the log and the job summary.
    console.error(`::error title=${title}::${res.reason}${fix ? " See the job summary for the form values." : ""}`);
    console.error(`\n${res.reason}\n\n${fix}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${title}\n\n${res.reason}\n\n${fix}\n`);
    }
    process.exit(1);
  }
}
