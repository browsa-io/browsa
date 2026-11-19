// URL token masking, on the server's answers (the module is bundled, so it is
// exercised through a tool answer that echoes the text it is given).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMockApi, startMcp } from "./helpers.mjs";

const SAMPLES = [
  ["https://x.test/cb?code=4/0AbC&state=xyz", "https://x.test/cb?code=***&state=xyz"],
  ["https://x.test/a?api_key=sk_live_1&q=shoes", "https://x.test/a?api_key=***&q=shoes"],
  ["https://x.test/r#access_token=eyJ.a.b&token_type=bearer", "https://x.test/r#access_token=***&token_type=bearer"],
  ["https://s3.test/f?X-Amz-Signature=abcd&X-Amz-Credential=AK%2F1&X-Amz-Date=2026", "https://s3.test/f?X-Amz-Signature=***&X-Amz-Credential=***&X-Amz-Date=2026"],
  ["https://x.test/p?sessionid=99;jsessionid=88", "https://x.test/p?sessionid=***;jsessionid=***"],
  ["https://x.test/s?keywords=red+shoes&country_code=us&page=2", "https://x.test/s?keywords=red+shoes&country_code=us&page=2"],
  ["https://browsa.io/live?agent=agt_1#c=lc_x.y", "https://browsa.io/live?agent=agt_1#c=lc_x.y"],
  ['[9] link "Reset"  → /reset?token=abc123', '[9] link "Reset"  → /reset?token=***'],
];

test("credential-like URL parameters are masked, others kept; off with BROWSA_MCP_REDACT=off", async () => {
  const text = SAMPLES.map((s) => s[0]).join("\n");
  const api = await startMockApi({
    "POST /v1/agents/agt_1/observe": () => ({ text, url: "https://x.test/", tab: "T1", session: "s" }),
  });
  const on = await startMcp(api.url).init();
  const off = await startMcp(api.url, { BROWSA_MCP_REDACT: "off" }).init();
  try {
    const r = await on.call("observe", { browser_id: "agt_1" });
    assert.deepEqual(r.text.split("\n"), SAMPLES.map((s) => s[1]));
    const r2 = await off.call("observe", { browser_id: "agt_1" });
    assert.equal(r2.text, text);
  } finally { on.kill(); off.kill(); api.close(); }
});
