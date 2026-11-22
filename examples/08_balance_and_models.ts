// Print the credit balance and the hosted model tiers with what each adds per task.
//
// Cost: 0 credits (both calls are free and read-only).
//
// Run:
//   npm i browsa
//   BROWSA_API_KEY=agt_live_... node 08_balance_and_models.ts   (Node 22.18+; or: npx tsx 08_balance_and_models.ts)
import { Client } from "browsa";

const client = new Client(); // reads BROWSA_API_KEY

const credits = await client.credits();
console.log("balance:", credits.balance, "credits");

const models = await client.models();
for (const tier of models.hosted) {
  const mark = tier.default ? " (default)" : "";
  console.log(`${tier.id}${mark}: ${tier.model}, +${tier.creditsPerTask} credits per task`);
}
console.log("own key providers:", models.ownKey.providers.join(", "));
