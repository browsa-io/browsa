// 0.3.1: the package's types must resolve for every kind of TypeScript
// consumer. 0.3.0 gave CommonJS projects under node16/nodenext resolution
// the ESM declaration file, which tsc rejects (TS1479).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("exports give each module kind its own declaration file, and the files exist", () => {
  for (const sub of [".", "./webhooks"]) {
    const e = pkg.exports[sub];
    assert.match(e.import.types, /\.d\.ts$/);
    assert.match(e.require.types, /\.d\.cts$/);
    for (const f of [e.import.types, e.import.default, e.require.types, e.require.default]) {
      assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing from the build`);
    }
  }
  assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
});

const SRC = `import { Client, VERSION, RateLimitError } from "browsa";
import type { Job, PageView, LiveLink, DownloadedFile } from "browsa";
import { verifySignature } from "browsa/webhooks";
export async function f(): Promise<void> {
  const c = new Client({ apiKey: "agt_x" });
  const j: Job = await c.getJob("x");
  const v: PageView = await c.observe("a");
  const l: LiveLink = await c.createLiveLink("a", { scope: "view" });
  const d: DownloadedFile[] = await c.listDownloads("a");
  void [j, v, l, d, VERSION, RateLimitError, verifySignature("b", "h", "s")];
}
`;

function typecheck(name, file, compilerOptions, pkgType) {
  test(`types resolve: ${name}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browsa-types-"));
    try {
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.symlinkSync(root, path.join(dir, "node_modules", "browsa"), "dir");
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgType ? { type: pkgType } : {}));
      fs.writeFileSync(path.join(dir, file), SRC);
      fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: "ES2022", lib: ["ES2022", "DOM"], skipLibCheck: false, types: [], preserveSymlinks: true, ...compilerOptions },
        files: [file],
      }));
      const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
      try { execFileSync(process.execPath, [tsc, "-p", dir], { encoding: "utf8", stdio: "pipe" }); }
      catch (e) { assert.fail(`tsc failed:\n${e.stdout}${e.stderr}`); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

typecheck("ESM consumer, NodeNext", "a.mts", { module: "NodeNext", moduleResolution: "NodeNext" });
typecheck("CommonJS consumer, Node16 (.cts)", "a.cts", { module: "Node16", moduleResolution: "Node16" });
typecheck("CommonJS consumer, Node16 (.ts, no type field)", "a.ts", { module: "Node16", moduleResolution: "Node16" });
typecheck("ESM consumer, Node16 (.ts, type: module)", "a.ts", { module: "Node16", moduleResolution: "Node16" }, "module");
typecheck("bundler resolution", "a.ts", { module: "ESNext", moduleResolution: "Bundler" });
typecheck("classic node10 resolution, CommonJS", "a.ts", { module: "CommonJS", moduleResolution: "Node10", ignoreDeprecations: "5.0" });
