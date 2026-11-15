#!/usr/bin/env node
/**
 * browsa CLI.
 *
 * One binary, no deps, drives the platform from the shell. Wraps the
 * SDK exactly — anything the SDK can do, the CLI can do.
 *
 *   browsa credits
 *   browsa keys
 *   browsa webhooks
 *   browsa run "Go to news.ycombinator.com and return the top story" \
 *             --llm-key sk-ant-...
 *   browsa job <uuid>
 *   browsa cancel <uuid>
 *
 * Env:
 *   BROWSA_API_KEY      required
 *   BROWSA_LLM_API_KEY  default LLM key for `run`
 *   BROWSA_LLM_KEY_ID   default saved LLM key id for `run`
 *   BROWSA_LLM          default LLM (claude-opus-5-5 with a per-task key;
 *                       otherwise the saved key's default model)
 *
 * Output is plain text for piping. Pass --json to get raw JSON envelopes
 * (then pipe to jq).
 */
import { Client, BrowsaError, type Job, type Reasoning } from "./index.js";

const HELP = `browsa: real browsers for AI agents

Usage:
  browsa credits                          Show balance + top-up packs
  browsa ledger [--limit N]               Per-job credit ledger
  browsa keys                             List API keys
  browsa webhooks                         List webhooks
  browsa identities                       List persistent identities
  browsa llm-keys                         List saved LLM keys (masked)
  browsa models                           List hosted models and own-key providers
  browsa run "<task>"                     Run a browser task
        [--llm <model>]                  Default: $BROWSA_LLM, else the saved key's default model
                                         Hosted, no LLM key: browsa, browsa-fast, browsa-smart
        [--reasoning low|medium|high]    Default: the model's default
        [--llm-key <key>]                Default: $BROWSA_LLM_API_KEY
        [--llm-key-id <id>]              Saved LLM key. Default: $BROWSA_LLM_KEY_ID
                                         With no key or key id, the workspace's
                                         default saved key is used
        [--country US|GB|DE|...]
        [--max-steps N]
        [--initial-url <url>]
        [--ja3 macos_chrome_137]
        [--profile-id <uuid>]
  browsa job <uuid>                       Fetch a job; with --wait N long-polls
        [--wait N]                       Block server-side up to N seconds (1-120)
  browsa cancel <uuid>                    Cancel a running job
  browsa respond <uuid> "<answer>"        Answer an input_required prompt
  browsa health                           Hit /v1/health (no auth)

Global flags:
  --json                  Print raw JSON envelopes (pipe to jq)
  --api-key <key>         Override $BROWSA_API_KEY for this call
  --base <url>            Override https://browsa.io
  --help                  This message
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

function parse(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function out(obj: unknown, json: boolean) {
  if (json) {
    console.log(JSON.stringify(obj, null, 2));
    return;
  }
  if (typeof obj === "string") return console.log(obj);
  console.log(JSON.stringify(obj, null, 2));
}

/** One line about the LLM side of a finished job; "" when the job has none of it. */
function llmSummary(job: Job): string {
  const parts: string[] = [];
  if (job.llmTier) parts.push(`tier=${job.llmTier}`);
  if (job.reasoning) parts.push(`reasoning=${job.reasoning}`);
  if (job.usage) {
    parts.push(`tokens in=${job.usage.inputTokens} out=${job.usage.outputTokens}`);
    parts.push(`requests=${job.usage.requests}`);
  }
  if (typeof job.llmCostUsd === "number") parts.push(`est. cost=$${job.llmCostUsd.toFixed(4)}`);
  return parts.length ? `llm: ${parts.join(" · ")}` : "";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }

  const args = parse(argv);
  const cmd = args.positional[0]!;
  const json = !!args.flags.json;
  const apiKey = (args.flags["api-key"] as string) || process.env.BROWSA_API_KEY;
  const baseUrl = (args.flags.base as string) || process.env.BROWSA_BASE_URL;

  if (cmd === "health") {
    const r = await fetch(`${baseUrl || "https://browsa.io"}/v1/health`);
    return out(await r.json(), json);
  }

  if (!apiKey) {
    console.error("error: BROWSA_API_KEY not set. Mint one at https://app.browsa.io/dashboard/keys");
    process.exit(2);
  }

  const c = new Client({ apiKey, ...(baseUrl ? { baseUrl } : {}) });

  try {
    switch (cmd) {
      case "credits": {
        const r = await c.credits();
        if (json) return out(r, true);
        console.log(`balance: ${r.balance}`);
        console.log(`packs:   ${(r.packs || []).map((p: any) => p.sku).join(", ")}`);
        return;
      }
      case "ledger": {
        const limit = args.flags.limit ? parseInt(args.flags.limit as string, 10) : 20;
        const r = await c.listLedger({ limit });
        if (json) return out(r, true);
        console.log(`balance: ${r.balance}  (${r.count} entries)\n`);
        for (const e of (r.entries || [])) {
          const sign = e.delta > 0 ? '+' : '';
          const ts = (e.created_at || '').slice(0, 19);
          console.log(`  ${ts}  ${sign}${String(e.delta).padStart(4)}  bal=${String(e.balance).padStart(5)}  ${e.reason || '-'}`);
        }
        return;
      }
      case "keys": {
        const r = await c.listKeys();
        if (json) return out(r, true);
        for (const k of r) {
          console.log(`${k.id?.slice(0, 8) ?? "-"}  ${k.name ?? "-"}  ${k.prefix ?? "-"}  ${k.revoked_at ? "[revoked]" : ""}`);
        }
        return;
      }
      case "webhooks": {
        const r = await c.listWebhooks();
        if (json) return out(r, true);
        if (!r.length) console.log("no webhooks");
        for (const h of r) {
          console.log(`${h.id.slice(0, 8)}  ${h.url}  ${(h.events || []).join(",") || "all"}`);
        }
        return;
      }
      case "llm-keys": {
        const r = await c.listLlmKeys();
        if (json) return out(r.map(({ raw, ...k }) => k), true);
        if (!r.length) console.log("no saved LLM keys (add one at https://app.browsa.io/dashboard/llm-keys)");
        for (const k of r) {
          console.log(`${k.id.slice(0, 8)}  ${k.provider}  ${k.masked}  ${k.status}${k.isDefault ? "  [default]" : ""}  ${k.name || ""}`);
        }
        return;
      }
      case "models": {
        const r = await c.models();
        if (json) return out(r.raw, true);
        if (!r.hosted.length) console.log("no hosted models");
        for (const h of r.hosted) {
          const credits = h.creditsPerTask != null ? `+${h.creditsPerTask} credits/task` : "-";
          console.log(`${h.id}  ${h.model || "-"}  reasoning=${h.reasoning ?? "default"}  ${credits}${h.default ? "  [default]" : ""}`);
        }
        if (r.ownKey.providers.length) {
          console.log("\nown key:");
          for (const p of r.ownKey.providers) {
            console.log(`  ${p}  ${r.ownKey.defaultModels[p] ?? "(name the model with --llm)"}`);
          }
        }
        return;
      }
      case "identities": {
        // GET /v1/agents also lists recent burners; identities are the persistent ones.
        const r = (await c.listIdentities()).filter((a) => a.mode === "persistent");
        if (json) return out(r, true);
        if (!r.length) console.log("no persistent identities");
        for (const a of r) {
          console.log(`${a.id ?? "-"}  ${a.persona ?? a.options?.os_type ?? "-"}  ${a.status ?? "-"}  trust=${a.trust_score ?? "-"}`);
        }
        return;
      }
      case "run": {
        const task = args.positional[1];
        if (!task) { console.error("error: missing task argument"); process.exit(2); }
        // Flags beat env; a per-task key beats a saved key id (server order).
        // With neither, the workspace's default saved key is used.
        const flagKey = args.flags["llm-key"] as string | undefined;
        const flagKeyId = args.flags["llm-key-id"] as string | undefined;
        let llmKey: string | undefined;
        let llmKeyId: string | undefined;
        if (typeof flagKey === "string") llmKey = flagKey;
        else if (typeof flagKeyId === "string") llmKeyId = flagKeyId;
        else if (process.env.BROWSA_LLM_API_KEY) llmKey = process.env.BROWSA_LLM_API_KEY;
        else if (process.env.BROWSA_LLM_KEY_ID) llmKeyId = process.env.BROWSA_LLM_KEY_ID;
        const llm = (args.flags.llm as string) || process.env.BROWSA_LLM || (llmKey ? "claude-opus-5-5" : undefined);
        // Sent as given; the API answers 400 for anything but low, medium or high.
        const reasoning = typeof args.flags.reasoning === "string" ? (args.flags.reasoning as Reasoning) : undefined;
        const via = llmKey ? "per-task key" : llmKeyId ? `saved key ${llmKeyId}` : "workspace default key";
        process.stderr.write(`submitting task… (llm=${llm ?? "default"}, ${via}${reasoning ? `, reasoning=${reasoning}` : ""})\n`);
        const job = await c.runTask({
          task,
          llm,
          llmApiKey: llmKey,
          llmKeyId,
          reasoning,
          country: (args.flags.country as string) || undefined,
          maxSteps: args.flags["max-steps"] ? parseInt(args.flags["max-steps"] as string, 10) : undefined,
          initialUrl: (args.flags["initial-url"] as string) || undefined,
          ja3Profile: (args.flags.ja3 as string) || undefined,
          profileId: (args.flags["profile-id"] as string) || undefined,
          onProgress: (j) => {
            if (!json) process.stderr.write(`  step ${j.stepCount}/${j.progressTotal} · ${j.status}\r`);
          },
        });
        if (!json) process.stderr.write("\n");
        if (json) return out(job, true);
        console.log(`\n=== ${job.status} · ${job.stepCount}/${job.progressTotal} · credits_charged=${job.creditsCharged ?? "?"} ===`);
        console.log(`live: ${job.liveUrl}`);
        const llmLine = llmSummary(job);
        if (llmLine) console.log(llmLine);
        if (job.finalResult) console.log("\n--- result ---\n" + job.finalResult);
        if (job.errorMessage) console.log("\n--- error ---\n" + job.errorMessage);
        return;
      }
      case "job": {
        const id = args.positional[1];
        if (!id) { console.error("error: missing job UUID"); process.exit(2); }
        const wait = args.flags.wait ? parseInt(args.flags.wait as string, 10) : 0;
        const job = await c.getJob(id, { wait });
        if (json) return out(job, true);
        console.log(`${job.id}  ${job.status}  ${job.stepCount}/${job.progressTotal}`);
        if (job.liveUrl) console.log(`live: ${job.liveUrl}`);
        const llmLine = llmSummary(job);
        if (llmLine) console.log(llmLine);
        if (job.finalResult) console.log("\n" + job.finalResult);
        if (job.errorMessage) console.log("\nerror: " + job.errorMessage);
        return;
      }
      case "cancel": {
        const id = args.positional[1];
        if (!id) { console.error("error: missing job UUID"); process.exit(2); }
        await c.cancelJob(id);
        console.log(`cancelled ${id}`);
        return;
      }
      case "respond": {
        const id = args.positional[1];
        const ans = args.positional[2];
        if (!id || !ans) { console.error("error: usage: browsa respond <uuid> \"<answer>\""); process.exit(2); }
        const job = await c.respondToJob(id, ans);
        if (json) return out(job, true);
        console.log(`${job.id}  ${job.status}`);
        return;
      }
      default:
        console.error(`unknown command: ${cmd}`);
        console.error(HELP);
        process.exit(2);
    }
  } catch (e) {
    if (e instanceof BrowsaError) {
      const body = { error: e.message, code: e.code, status: e.status, request_id: e.requestId };
      if (json) { console.log(JSON.stringify(body, null, 2)); process.exit(1); }
      console.error(`error: ${e.message}`);
      if (e.code)      console.error(`  code:       ${e.code}`);
      if (e.requestId) console.error(`  request_id: ${e.requestId}`);
      process.exit(1);
    }
    console.error("error:", (e as Error).message || e);
    process.exit(1);
  }
}

main();
