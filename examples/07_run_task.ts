// Run one agent task in a Phantom cloud browser, on Browsa's hosted model (no LLM key).
//
// Cost: about 8 credits (browser 1 + task 1 + 1 per 5 steps + the hosted tier's 5 per task).
//       Capped here at 10 with maxCredits. A task that fails is not charged.
//
// Run:
//   npm i browsa
//   BROWSA_API_KEY=agt_live_... node 07_run_task.ts        (Node 22.18+; or: npx tsx 07_run_task.ts)
import { Client } from "browsa";

const client = new Client(); // reads BROWSA_API_KEY
const job = await client.runTask({
  task: "Open https://news.ycombinator.com and return the title of the first story.",
  llm: "browsa", // hosted tier: no LLM key of your own
  maxSteps: 5,
  maxCredits: 10, // the most this task may charge
  onProgress: (j) => { if (j.liveUrl) console.log("watch live:", j.liveUrl); },
});
// status says the run ended; outcome says how it ended.
console.log("status:", job.status, "| outcome:", job.outcome);
console.log("result:", job.finalResult);
console.log("steps:", job.stepCount, "| credits charged:", job.creditsCharged);
