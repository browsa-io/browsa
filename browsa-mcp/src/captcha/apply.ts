// The "apply" block of a solved task: what the caller does with the answer
// in a browser of their own. The server never touches that browser; it only
// writes the expression.
//
// Where the answer goes is what the widgets themselves do, as Browsa's
// extension and in-session solver know them:
//   Turnstile   the hidden input "cf-turnstile-response" the widget keeps in
//               its container, then the widget's callback (data-callback)
//   reCAPTCHA   every "g-recaptcha-response" textarea, then the callback from
//               data-callback or from the widget's own client table
//               (___grecaptcha_cfg.clients)
//   v3          no field: the page's script asks grecaptcha.execute() for a
//               token when it acts, so that call is made to answer this token
//   Cloudflare  check page: a cookie, to be sent with the same user agent
//
// The expressions use spaces around "=" on purpose: the server masks
// URL-style "name=value" credentials in every answer, and must not touch code.

export interface ApplyHints { callback?: string; responseField?: string }

export interface ApplyBlock {
  how: "evaluate" | "cookies" | "manual";
  /** A JavaScript expression for the page's main frame. Evaluates to {applied, fields, callback, ...}. */
  expression?: string;
  cookies?: Array<{ name: string; value: string; domain: string; path: string; secure: boolean }>;
  user_agent?: string;
  /** What to do, in order. */
  steps: string[];
  /** How long the answer is good for, when the provider says. */
  valid_seconds?: number;
}

const js = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));

// Shared by both expressions: set a field as a person's script would, and call a page function by its dotted name.
const HELPERS = `
  const out = { applied: false, fields: 0, callback: "none" };
  const put = (el) => { el.value = token; for (const ev of ["input", "change"]) el.dispatchEvent(new Event(ev, { bubbles: true })); out.fields += 1; };
  const call = (fn, label) => { try { fn(token); out.callback = "called " + label; } catch (e) { out.callback = "threw in " + label + ": " + (e && e.message); } };
  const named = (name) => { const f = String(name).split(".").reduce((o, k) => (o == null ? o : o[k]), window); if (typeof f === "function") call(f, name); else out.callback = "not a function: " + name; };`;

export function turnstileExpression(token: string, hints: ApplyHints = {}): string {
  return `(() => {
  const token = ${js(token)};
  const wanted = ${js(hints.callback ?? null)};
  const fieldName = ${js(hints.responseField || "cf-turnstile-response")};${HELPERS}
  const widgets = Array.from(document.querySelectorAll(".cf-turnstile"));
  let fields = Array.from(document.querySelectorAll("input[name='" + fieldName + "'], textarea[name='" + fieldName + "']"));
  if (!fields.length) {
    const host = widgets[0] || document.querySelector("form");
    if (host) { const i = document.createElement("input"); i.type = "hidden"; i.name = fieldName; host.appendChild(i); fields = [i]; out.created_field = true; }
  }
  fields.forEach(put);
  for (const w of widgets) w.querySelectorAll("[name='g-recaptcha-response']").forEach(put);
  if (window.turnstile && typeof window.turnstile.getResponse === "function") { try { window.turnstile.getResponse = () => token; out.get_response = "answers this token"; } catch (e) {} }
  const cb = wanted || widgets.map((w) => w.getAttribute("data-callback")).find(Boolean);
  if (cb) named(cb);
  out.applied = out.fields > 0 || out.callback.indexOf("called") === 0;
  return out;
})()`;
}

export function recaptchaExpression(token: string, hints: ApplyHints = {}, v3 = false): string {
  return `(() => {
  const token = ${js(token)};
  const wanted = ${js(hints.callback ?? null)};
  const v3 = ${v3 ? "true" : "false"};${HELPERS}
  const widgets = Array.from(document.querySelectorAll(".g-recaptcha"));
  let fields = Array.from(document.querySelectorAll("textarea[name='g-recaptcha-response'], textarea[id^='g-recaptcha-response'], input[name='g-recaptcha-response']"));
  if (!fields.length && !v3) {
    const host = widgets[0] || document.querySelector("form");
    if (host) { const t = document.createElement("textarea"); t.name = "g-recaptcha-response"; t.style.display = "none"; host.appendChild(t); fields = [t]; out.created_field = true; }
  }
  fields.forEach(put);
  const apis = [window.grecaptcha, window.grecaptcha && window.grecaptcha.enterprise].filter(Boolean);
  for (const g of apis) {
    try { if (typeof g.getResponse === "function") { g.getResponse = () => token; out.get_response = "answers this token"; } } catch (e) {}
    try { if (v3 && typeof g.execute === "function") { g.execute = () => Promise.resolve(token); out.execute = "answers this token"; } } catch (e) {}
  }
  let cb = wanted || widgets.map((w) => w.getAttribute("data-callback")).find(Boolean);
  if (cb) named(cb);
  else if (!v3) {
    const seen = new Set();
    const find = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 5 || seen.has(o)) return null;
      if (typeof Node !== "undefined" && o instanceof Node) return null;
      seen.add(o);
      for (const k of Object.keys(o)) {
        let v; try { v = o[k]; } catch (e) { continue; }
        if (k === "callback" && (typeof v === "function" || typeof v === "string")) return v;
        const r = find(v, depth + 1);
        if (r) return r;
      }
      return null;
    };
    const cfg = window.___grecaptcha_cfg;
    const found = cfg && cfg.clients ? find(cfg.clients, 0) : null;
    if (typeof found === "function") call(found, "the widget's callback");
    else if (typeof found === "string") named(found);
  }
  out.applied = out.fields > 0 || out.callback.indexOf("called") === 0 || !!out.execute;
  return out;
})()`;
}

const TOKEN_STEPS = [
  "Evaluate apply.expression in the page's main frame.",
  "If its result has callback \"called ...\", the page has the token: wait for the page to move on. Otherwise submit the form the widget is in.",
  "Check the page's own answer. applied false means no field or callback was found: the widget may be in another frame, or not rendered yet.",
];

/**
 * The apply block for a solution of `type` (a catalogue name).
 * websiteURL is used for the cookie's domain.
 */
export function buildApply(type: string, solution: any, websiteURL: string | undefined, hints: ApplyHints = {}): ApplyBlock {
  const s = solution ?? {};
  if (/Cloudflare/i.test(type) || (s.cookies && typeof s.cookies === "object")) {
    let host = "";
    try { host = new URL(String(websiteURL)).hostname; } catch { /* no domain */ }
    const cookies = Object.entries(s.cookies ?? (s.token ? { cf_clearance: s.token } : {}))
      .map(([name, value]) => ({ name, value: String(value), domain: host, path: "/", secure: true }));
    return {
      how: "cookies", cookies, ...(s.userAgent ? { user_agent: String(s.userAgent) } : {}),
      steps: [
        "Set these cookies in your browser for that domain, and send exactly this user agent.",
        "Re-request the URL through the same proxy the task used. Do not reload the challenge page: a reload asks for a new check.",
        "The cookie only works from the address that passed the check.",
      ],
    };
  }
  if (typeof s.token === "string" && /Turnstile/i.test(type)) {
    return { how: "evaluate", expression: turnstileExpression(s.token, hints), steps: TOKEN_STEPS, valid_seconds: 300 };
  }
  if (typeof s.gRecaptchaResponse === "string") {
    const v3 = /V3/i.test(type);
    return {
      how: "evaluate", expression: recaptchaExpression(s.gRecaptchaResponse, hints, v3), valid_seconds: 120,
      steps: v3
        ? ["Evaluate apply.expression in the page's main frame: the page's next grecaptcha.execute() call answers this token.",
          "Then do the page's own action (its button): its script sends the token.",
          "A v3 token is scored by the site; check the page's own answer."]
        : TOKEN_STEPS,
    };
  }
  return { how: "manual", steps: ["This solution has no page step this server knows: use its fields as the page's own code would."] };
}
