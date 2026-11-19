// Reading the page view text: element lines, find, and one container's lines.
// The format is the API's (one element per line, `[id] role "name"  state`,
// two spaces of indent per level, page strings always in double quotes).

export type ElementRef = { role: string; name: string };

// `[14] textbox "Postcode"  ...`, also inside a diff line (`~ [14] ...`, `+ [14] ...`).
const ELEMENT = /^\s*(?:[~+-] )?\[(\d+)\] ([A-Za-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?/;

function unquote(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}

/** Every element line of a view or a diff: id -> role and name. */
export function elementsOf(text: string): Map<number, ElementRef> {
  const out = new Map<number, ElementRef>();
  for (const line of text.split("\n")) {
    const m = ELEMENT.exec(line);
    if (m) out.set(Number(m[1]), { role: m[2], name: m[3] !== undefined ? unquote(m[3]) : "" });
  }
  return out;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function matcher(query: string): (s: string) => boolean {
  const re = /^\/(.+)\/([a-z]*)$/s.exec(query.trim());
  if (re) {
    try {
      const flags = re[2].includes("i") ? re[2] : re[2] + "i";
      const rx = new RegExp(re[1], flags.replace(/[gy]/g, ""));
      return (s) => rx.test(s);
    } catch { /* not a valid expression: plain text below */ }
  }
  const q = query.trim().toLowerCase();
  return (s) => s.toLowerCase().includes(q);
}

const SUMMARY = /^(page |dialog: |above the fold:|below the fold:|off to the side:|behind dialog:|… )/;

/**
 * The lines of a full view that match query (plain text, case-insensitive,
 * or /regex/), each with the nearest container it is in.
 */
export function findInView(text: string, query: string, maxMatches = 25, maxChars = 2400): string {
  const lines = text.split("\n");
  const head = lines[0]?.startsWith("page ") ? lines[0] : "";
  const test = matcher(query);
  const stack: { indent: number; line: string }[] = [];
  const hits: string[] = [];
  let count = 0;
  for (let i = head ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
    if (!SUMMARY.test(line.trim()) && test(line)) {
      count++;
      if (hits.length < maxMatches) {
        const parent = [...stack].reverse().find((s) => ELEMENT.test(s.line));
        let hit = line.trim();
        if (parent) {
          const p = parent.line.trim();
          hit += `   (in ${p.length > 60 ? p.slice(0, 57) + "..." : p})`;
        }
        hits.push(hit);
      }
    }
    if (ELEMENT.test(line)) stack.push({ indent: ind, line });
  }
  let body = hits.join("\n");
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    body = body.slice(0, body.lastIndexOf("\n") > 0 ? body.lastIndexOf("\n") : body.length);
  }
  const shown = body ? body.split("\n").length : 0;
  const out = [`find ${JSON.stringify(query)}: ${count} match${count === 1 ? "" : "es"}`];
  if (head) out.push(head);
  if (body) out.push(body);
  if (count > shown) out.push(`… ${count - shown} more (narrow find, or observe with expand)`);
  if (!count) out.push("nothing on the page matches; try other words, or scroll and observe");
  return out.join("\n");
}

/** The line of element id and every line under it, de-indented. "" when absent. */
export function subtreeLines(text: string, id: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => { const m = ELEMENT.exec(l); return !!m && Number(m[1]) === id && !/^\s*[~+-] /.test(l); });
  if (start < 0) return "";
  const base = indentOf(lines[start]);
  const out = [lines[start].slice(base)];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indentOf(l) <= base) break;
    out.push(l.slice(base));
  }
  return out.join("\n");
}

/** Approximate tokens of a text (characters / 4, the API's own estimate). */
export function tokensOf(s: string): number {
  return Math.ceil(s.length / 4);
}
