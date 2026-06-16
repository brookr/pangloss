/**
 * Pull the first balanced JSON object/array out of arbitrary CLI text output.
 *
 * Frontier CLIs wrap their answer in prose, markdown fences, log lines, ANSI,
 * etc. We instruct agents to emit a JSON block and then recover it robustly by
 * scanning for the first `{`/`[` and matching brackets (string- and
 * escape-aware) rather than a greedy regex, so trailing log noise doesn't break
 * the parse.
 */
export function extractJsonBlock<T = unknown>(text: string): T | null {
  if (!text) return null;

  // Strip markdown code fences if present — they're the most common wrapper.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);

  for (const source of candidates) {
    const found = scanBalanced(source);
    if (found !== null) {
      try {
        return JSON.parse(found) as T;
      } catch {
        // keep trying other candidates
      }
    }
  }
  return null;
}

function scanBalanced(source: string): string | null {
  const start = firstOpener(source);
  if (start === -1) return null;

  const open = source[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

function firstOpener(source: string): number {
  const brace = source.indexOf('{');
  const bracket = source.indexOf('[');
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}
