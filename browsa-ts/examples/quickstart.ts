// Five-line hello world.
//   export BROWSA_API_KEY=agt_live_...
//   export ANTHROPIC_API_KEY=sk-ant-...   (optional: without it the task runs
//                                          on Browsa's hosted model, +5 credits)
//   npm i browsa
//   npx tsx quickstart.ts
import { Client } from "browsa";

const c = new Client({ apiKey: process.env.BROWSA_API_KEY! });
const llmKey = process.env.ANTHROPIC_API_KEY;
const job = await c.runTask({
  task: "Go to https://news.ycombinator.com and return the title of the #1 story.",
  llm: llmKey ? "claude-opus-5-5" : "browsa",
  llmApiKey: llmKey,
  maxSteps: 5,
});
console.log("\n=== result ===\n", job.finalResult);
console.log("\n=== live stream (was) ===\n", job.liveUrl);
console.log(`\n=== steps === ${job.stepCount}/${job.progressTotal}`);
