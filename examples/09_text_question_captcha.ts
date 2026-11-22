// Answer an anti-spam question asked in words (TextCaptchaTask) with the captcha API.
//
// Cost: 0.004 credits per solved question. A failed solve is free.
//
// Run:
//   npm i browsa
//   BROWSA_API_KEY=agt_live_... node 09_text_question_captcha.ts ["your question"]
//   (Node 22.18+; or: npx tsx 09_text_question_captcha.ts)
import { CaptchaClient, CaptchaError, captchaTasks } from "browsa";

const question = process.argv[2] ?? "If tomorrow is Saturday, what day is today?";
const cap = new CaptchaClient(); // reads BROWSA_API_KEY

try {
  const sol = await cap.solve(captchaTasks.textQuestion(question));
  console.log("question:", question);
  console.log("answer:", sol.text, sol.alternatives?.length ? `(also: ${sol.alternatives.join(", ")})` : "");
  console.log("task:", sol.taskId, "| seconds:", sol.solveSeconds, "| cost:", JSON.stringify(sol.cost));
} catch (e) {
  if (!(e instanceof CaptchaError)) throw e;
  console.error(`failed: ${e.code}: ${e.message}\nfix: ${e.fix}\ncharged: ${e.charged}`);
  process.exit(1);
}
