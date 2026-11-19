// Flows: steps recorded from act and read calls, saved as a Browsa recipe
// (recipe v1, the format replays and robots run) and replayed with no
// model calls. Only the recording lives here; the API stores and runs it.

export type Target = { role?: string; name?: string; css?: string };

export type Step = Record<string, unknown> & { id: string; kind: string };

export type Recording = {
  startUrl: string;
  steps: Step[];
  reads: number;
  notes: string[];
};

export function newRecording(startUrl: string): Recording {
  return { startUrl, steps: [], reads: 0, notes: [] };
}

function describeTarget(t: Target): string {
  const what = t.name ? JSON.stringify(t.name) : t.css ? t.css : "the element";
  return `${t.role || "element"} ${what}`;
}

function cleanTarget(t: Target | undefined): Target | undefined {
  if (!t) return undefined;
  const out: Target = {};
  if (t.role) out.role = t.role;
  if (t.name) out.name = t.name;
  if (t.css) out.css = t.css;
  return Object.keys(out).length ? out : undefined;
}

/** A secret reference as the recipe token the replay worker resolves. */
export function secretToken(ref: string): string {
  const r = ref.trim();
  const totp = /^TOTP:([A-Za-z0-9_]{1,64})$/i.exec(r);
  if (totp) return `{{totp:${totp[1].toUpperCase()}}}`;
  const part = /^([A-Za-z0-9_]{1,64}):(username|password)$/i.exec(r);
  if (part) return `{{secret:${part[1].toUpperCase()}:${part[2].toLowerCase()}}}`;
  return `{{secret:${r.toUpperCase()}}}`;
}

/**
 * Adds the step for one successful act. target: the API's locators for the
 * element (act record), else role and name from the last view. url: the
 * page after the action. Returns a note when the action is not recorded.
 */
export function recordAct(rec: Recording, args: Record<string, any>, target: Target | undefined, url: string, secretRef?: string): string | undefined {
  const n = rec.steps.length + 1;
  const id = `s${n}`;
  const t = cleanTarget(target);
  const need = (kind: string): string | undefined => {
    if (t) return undefined;
    const note = `${kind} on [${args.id ?? "?"}] not recorded: the element was not in a view (observe first)`;
    rec.notes.push(note);
    return note;
  };
  switch (args.action) {
    case "navigate":
      rec.steps.push({ id, kind: "navigate", url: String(args.url) });
      return;
    case "back": case "forward": case "reload":
      if (url) rec.steps.push({ id, kind: "navigate", url });
      return;
    case "click": case "check": case "uncheck": {
      if (args.x !== undefined && !args.id && !args.role) {
        const note = "click at a point not recorded: a replay needs an element";
        rec.notes.push(note);
        return note;
      }
      const miss = need(args.action);
      if (miss) return miss;
      rec.steps.push({ id, kind: "click", target: t, goal: `click the ${describeTarget(t!)}` });
      return;
    }
    case "type": {
      const miss = need("type");
      if (miss) return miss;
      const text = secretRef ? secretToken(secretRef) : String(args.text ?? "");
      const step: Step = { id, kind: "type", target: t, text, goal: `type into the ${describeTarget(t!)}` };
      if (args.submit) step.submit = true;
      rec.steps.push(step);
      return;
    }
    case "select": {
      const miss = need("select");
      if (miss) return miss;
      rec.steps.push({ id, kind: "select", target: t, value: String(args.option ?? ""), goal: `choose ${JSON.stringify(args.option)} in the ${describeTarget(t!)}` });
      return;
    }
    case "press":
      rec.steps.push({ id, kind: "press", keys: String(args.keys ?? "") });
      return;
    case "scroll":
      if (typeof args.dy === "number" && args.dy !== 0) rec.steps.push({ id, kind: "scroll", value: String(args.dy) });
      else if (args.to) rec.steps.push({ id, kind: "scroll", value: args.to === "top" ? "up" : "down", pages: 50 });
      return;
    case "wait":
      if (args.for === "text" && args.text) {
        rec.steps.push({ id, kind: "wait", for: { text: String(args.text) }, timeout_ms: Math.min(Math.max(Number(args.timeout) || 15000, 100), 120000) });
      } else if (args.for === "url-change" && url) {
        rec.steps.push({ id, kind: "wait", for: { url }, timeout_ms: Math.min(Math.max(Number(args.timeout) || 15000, 100), 120000) });
      }
      return;
  }
  // hover, upload, dialog, solve_captcha, press_and_hold: a replay solves
  // checks in its own session; the others have no replay step.
  if (!["solve_captcha", "press_and_hold", "hover"].includes(args.action)) {
    const note = `${args.action} not recorded: replays have no such step`;
    rec.notes.push(note);
    return note;
  }
  return;
}

function fieldName(s: string, i: number, seen: Set<string>): string {
  let n = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!n || !/^[a-z]/.test(n)) n = `col${i + 1}`;
  while (seen.has(n)) n += "_";
  seen.add(n);
  return n;
}

/**
 * Adds the extract step for one read of a container. selector: the API's CSS
 * selector for it ("" when it has none). headers: a table's column names.
 */
export function recordRead(rec: Recording, as: string, selector: string, headers: string[]): { into?: string; note?: string } {
  if (!selector) {
    const note = "read not recorded: the API gave no selector for that container (inside a frame, or the API is older)";
    rec.notes.push(note);
    return { note };
  }
  rec.reads++;
  const into = `read_${rec.reads}`;
  const id = `s${rec.steps.length + 1}`;
  let how: Record<string, unknown>;
  if (as === "table") {
    const seen = new Set<string>();
    const fields: Record<string, string> = {};
    const cols = headers.length ? headers : ["col1"];
    cols.forEach((h, i) => { fields[fieldName(h, i, seen)] = `:scope > :nth-child(${i + 1})`; });
    how = { css: `${selector} tbody tr`, fields, into, allow_empty: true };
  } else if (as === "links") {
    how = { css: `${selector} a[href]`, fields: { text: ".", href: "@href" }, into, allow_empty: true };
  } else {
    how = { css: selector, into };
  }
  rec.steps.push({ id, kind: "extract", from: "page", how, goal: `read the ${as} of ${selector}` });
  return { into };
}

function replaceAll(s: string, find: string, by: string): string {
  return find ? s.split(find).join(by) : s;
}

/** Puts {{param}} where an example value was typed or navigated to. */
function parameterize(v: unknown, params: Record<string, string>): unknown {
  if (typeof v === "string") {
    let s = v;
    for (const [name, ex] of Object.entries(params)) {
      if (!ex) continue;
      const tok = `{{${name}}}`;
      s = replaceAll(s, ex, tok);
      s = replaceAll(s, encodeURIComponent(ex), tok);
      s = replaceAll(s, ex.replace(/ /g, "+"), tok);
    }
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => parameterize(x, params));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === "target" || k === "how" ? x : parameterize(x, params);
    return out;
  }
  return v;
}

/** The recipe v1 body for a recording. params: {name: example value}. */
export function buildRecipe(rec: Recording, name: string, params: Record<string, string>): Record<string, unknown> {
  const steps = rec.steps.map((s) => parameterize(s, params) as Step);
  // The page the recording started on comes first, unless the first step
  // goes somewhere itself.
  const startsWeb = /^https?:\/\//.test(rec.startUrl);
  if (startsWeb && steps[0]?.kind !== "navigate") {
    steps.unshift({ id: "s0", kind: "navigate", url: parameterize(rec.startUrl, params) as string });
  }
  const paramProps: Record<string, unknown> = {};
  for (const p of Object.keys(params)) paramProps[p] = { type: "string" };
  const outProps: Record<string, unknown> = {};
  for (let i = 1; i <= rec.reads; i++) outProps[`read_${i}`] = { type: "array" };
  const recipe: Record<string, unknown> = {
    name,
    version: 1,
    params: { type: "object", properties: paramProps, required: Object.keys(params) },
    output: { type: "object", properties: outProps },
    steps,
    meta: { source: "mcp", recorded_steps: steps.length },
  };
  if (startsWeb && parameterize(rec.startUrl, params) === rec.startUrl) recipe.start_url = rec.startUrl;
  return recipe;
}

/** A recipe name: lowercase letters, digits and dashes. */
export function flowName(raw: string): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}
