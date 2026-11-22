#!/usr/bin/env node
// Release notes for a package tag: the tag's package and version, and that
// version's section of the changelog.
//
//   node .github/scripts/release-notes.mjs browsa-mcp-v0.8.1            notes on stdout
//   node .github/scripts/release-notes.mjs browsa-mcp-v0.8.1 --json     {package, version, title, registry, notes}
//
// Tags:   browsa-ts-v<version>          npm `browsa`           CHANGELOG.md
//         browsa-python-v<version>      PyPI `browsa`          CHANGELOG.md
//         browsa-mcp-v<version>         npm `@browsa/mcp`      CHANGELOG.md
//         n8n-nodes-browsa-v<version>   npm `n8n-nodes-browsa` integrations/n8n-nodes-browsa/CHANGELOG.md
//         langchain-browsa-v<version>   PyPI `langchain-browsa` integrations/langchain-browsa/CHANGELOG.md
//         crewai-browsa-v<version>      PyPI `crewai-browsa`   integrations/crewai-browsa/CHANGELOG.md
//
// It exits 1 with a message when the tag is not one of these, when the
// changelog has no section for the version, or when the section belongs to
// another package (a heading that says "`@browsa/mcp` only").
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const PACKAGES = {
  "browsa-ts": { name: "browsa", registry: "npm", changelog: "CHANGELOG.md", dir: "browsa-ts", install: "npm install browsa@{v}", label: "browsa {v} (npm)" },
  "browsa-python": { name: "browsa", registry: "pypi", changelog: "CHANGELOG.md", dir: "browsa-python", install: "pip install browsa=={v}", label: "browsa {v} (PyPI)" },
  "browsa-mcp": { name: "@browsa/mcp", registry: "npm", changelog: "CHANGELOG.md", dir: "browsa-mcp", install: "npx -y @browsa/mcp@{v}", label: "@browsa/mcp {v}" },
  "n8n-nodes-browsa": { name: "n8n-nodes-browsa", registry: "npm", changelog: "integrations/n8n-nodes-browsa/CHANGELOG.md", dir: "integrations/n8n-nodes-browsa", install: "npm install n8n-nodes-browsa@{v}", label: "n8n-nodes-browsa {v}" },
  "langchain-browsa": { name: "langchain-browsa", registry: "pypi", changelog: "integrations/langchain-browsa/CHANGELOG.md", dir: "integrations/langchain-browsa", install: "pip install langchain-browsa=={v}", label: "langchain-browsa {v}" },
  "crewai-browsa": { name: "crewai-browsa", registry: "pypi", changelog: "integrations/crewai-browsa/CHANGELOG.md", dir: "integrations/crewai-browsa", install: "pip install crewai-browsa=={v}", label: "crewai-browsa {v}" },
};

const VERSION = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?$/;

/** {key, version} from a tag such as "browsa-mcp-v0.8.1"; throws on anything else. */
export function parseTag(tag) {
  const m = /^(.+)-v(.+)$/.exec(String(tag ?? ""));
  if (!m || !PACKAGES[m[1]] || !VERSION.test(m[2])) {
    throw new Error(`"${tag}" is not a package tag. Expected one of: ${Object.keys(PACKAGES).map((k) => `${k}-v<version>`).join(", ")}`);
  }
  return { key: m[1], version: m[2] };
}

/** The lines under "## <version> ..." up to the next "## " heading, and the heading itself. */
export function sectionOf(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^##\\s+\\[?v?${esc}\\]?(?=\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return { heading: lines[start].replace(/^##\s+/, "").trim(), body: lines.slice(start + 1, end).join("\n").trim() };
}

/** Which packages a root-changelog heading covers: a heading that names packages covers only those. */
export function headingCovers(heading, key) {
  const names = { "browsa-mcp": /`@browsa\/mcp`/, "browsa-ts": /npm `browsa`/, "browsa-python": /PyPI `browsa`/ };
  if (!names[key]) return true;                       // an integration's own changelog
  const named = Object.entries(names).filter(([, re]) => re.test(heading)).map(([k]) => k);
  return named.length === 0 || named.includes(key);   // no package named: all three share the version
}

export function releaseNotes(tag, root = process.cwd()) {
  const { key, version } = parseTag(tag);
  const pkg = PACKAGES[key];
  const file = path.join(root, pkg.changelog);
  let text;
  try { text = readFileSync(file, "utf-8"); } catch { throw new Error(`${pkg.changelog} is missing: add it with a "## ${version}" section`); }
  const section = sectionOf(text, version);
  if (!section || !section.body) throw new Error(`${pkg.changelog} has no "## ${version}" section: write the release notes there first`);
  if (!headingCovers(section.heading, key)) {
    throw new Error(`"## ${section.heading}" in ${pkg.changelog} is for another package, not ${pkg.name} (${pkg.registry})`);
  }
  const fill = (s) => s.replaceAll("{v}", version);
  const where = pkg.registry === "npm"
    ? `https://www.npmjs.com/package/${pkg.name}/v/${version}`
    : `https://pypi.org/project/${pkg.name}/${version}/`;
  const notes = `${section.body}\n\n---\n\nInstall: \`${fill(pkg.install)}\` · [${pkg.registry === "npm" ? "npm" : "PyPI"}](${where}) · [source](https://github.com/browsa-io/browsa/tree/${tag}/${pkg.dir})\n`;
  return { tag, package: pkg.name, registry: pkg.registry, version, title: fill(pkg.label), changelog: pkg.changelog, notes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const out = releaseNotes(process.argv[2]);
    process.stdout.write(process.argv.includes("--json") ? JSON.stringify(out, null, 1) + "\n" : out.notes);
  } catch (e) {
    console.error(`::error title=Release notes::${e.message}`);
    process.exit(1);
  }
}
