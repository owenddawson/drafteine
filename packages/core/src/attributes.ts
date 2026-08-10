/**
 * The attribute container: `{ key: value, flag, preset: name }`. One
 * grammar for every attribute in the language, inline or expanded over
 * lines. `{` followed by nothing (or a comment) opens the expanded form;
 * any same-line `}` makes it inline. Comma or line break separates items,
 * trailing commas are fine, list values sit in `[brackets]`.
 *
 * Recovery never crosses a physical line: on a malformed item the scanner
 * reports and resynchronizes at the next comma, closing delimiter, or end
 * of line, so one typo cannot eat the rest of an entry.
 */
import type { Diagnostic, Line } from "./types.js";
import { QUOTED_NAME_RE, unescape } from "./names.js";

const KEY_RE = /^[A-Za-z][\w-]*/;

function report(line: Line, diagnostics: Diagnostic[], diag: Diagnostic): void {
  line.errors.push(diag);
  diagnostics.push(diag);
}

/** Skip spaces and tabs from `i`, returning the next content index. */
function ws(raw: string, i: number): number {
  while (raw[i] === " " || raw[i] === "\t") i++;
  return i;
}

/** True at a bare-value terminator: `, } ] #` or end of line. */
function atStop(raw: string, i: number): boolean {
  return i >= raw.length || raw[i] === "," || raw[i] === "}" || raw[i] === "]" || raw[i] === "#";
}

/** Scan one `[a, b, c]` list value. Returns the index after `]`. */
function scanList(
  line: Line,
  raw: string,
  open: number,
  items: string[],
  diagnostics: Diagnostic[]
): number {
  let i = open + 1;
  for (;;) {
    i = ws(raw, i);
    if (raw[i] === "]") return i + 1;
    if (i >= raw.length || raw[i] === "#" || raw[i] === "}") {
      report(line, diagnostics, {
        from: line.from + open,
        to: line.from + i,
        severity: "error",
        message: "Unclosed “[” list. Expected a closing “]”.",
      });
      return i;
    }
    if (raw[i] === ",") {
      i++;
      continue;
    }
    if (raw[i] === "[") {
      report(line, diagnostics, {
        from: line.from + i,
        to: line.from + i + 1,
        severity: "error",
        message: "Lists do not nest.",
      });
      i++;
      continue;
    }
    if (raw[i] === '"') {
      const q = QUOTED_NAME_RE.exec(raw.slice(i));
      if (q) {
        items.push(unescape(q[1]));
        i += q[0].length;
        continue;
      }
    }
    let j = i;
    while (j < raw.length && !",]#}".includes(raw[j])) j++;
    const item = raw.slice(i, j).trim();
    if (item !== "") items.push(item);
    i = j;
  }
}

/**
 * Scan attribute items at `raw[i]` until a top-level `}` (when
 * `stopAtBrace`) or end of line. Annotations and a trailing comment land
 * on `line`. Returns the index after the consumed region and whether the
 * closing `}` was seen.
 */
export function scanItems(
  line: Line,
  raw: string,
  i: number,
  stopAtBrace: boolean,
  diagnostics: Diagnostic[]
): { end: number; closed: boolean } {
  for (;;) {
    i = ws(raw, i);
    if (i >= raw.length) return { end: i, closed: false };
    if (raw[i] === "#") {
      line.spans.comment = [line.from + i, line.to];
      return { end: raw.length, closed: false };
    }
    if (raw[i] === "}") {
      return stopAtBrace
        ? { end: i + 1, closed: true }
        : (report(line, diagnostics, {
            from: line.from + i,
            to: line.from + i + 1,
            severity: "error",
            message: "Unmatched “}” in the attribute items.",
          }),
          { end: i + 1, closed: false });
    }
    if (raw[i] === ",") {
      i++; // empty items and trailing commas are tolerated
      continue;
    }

    const keyMatch = KEY_RE.exec(raw.slice(i));
    if (!keyMatch) {
      report(line, diagnostics, {
        from: line.from + i,
        to: line.to,
        severity: "error",
        message: "Expected an attribute: “key: value”, a flag word, or “}”.",
      });
      while (i < raw.length && raw[i] !== "," && raw[i] !== "}") i++;
      continue;
    }
    const keyStart = i;
    const key = keyMatch[0];
    i += key.length;
    i = ws(raw, i);

    if (raw[i] !== ":") {
      // A flag. The next thing must be a separator or the end.
      if (!atStop(raw, i)) {
        report(line, diagnostics, {
          from: line.from + i,
          to: line.to,
          severity: "error",
          message: `Expected “:” after “${key}”, or a comma between items.`,
        });
        while (i < raw.length && raw[i] !== "," && raw[i] !== "}") i++;
        continue;
      }
      line.annotations.push({
        key,
        value: null,
        values: [],
        from: line.from + keyStart,
        to: line.from + i,
      });
      continue;
    }

    i = ws(raw, i + 1);
    const values: string[] = [];
    if (raw[i] === "[") {
      i = scanList(line, raw, i, values, diagnostics);
    } else if (raw[i] === '"') {
      const q = QUOTED_NAME_RE.exec(raw.slice(i));
      if (q) {
        values.push(unescape(q[1]));
        i += q[0].length;
      } else {
        report(line, diagnostics, {
          from: line.from + i,
          to: line.to,
          severity: "error",
          message: "Unterminated quoted value.",
        });
        i = raw.length;
      }
    } else {
      let j = i;
      while (!atStop(raw, j)) j++;
      const bare = raw.slice(i, j).trim();
      if (bare === "") {
        report(line, diagnostics, {
          from: line.from + keyStart,
          to: line.from + j,
          severity: "error",
          message: `Missing value after “${key}:”. Write a value or drop the colon for a flag.`,
        });
        i = j;
        continue;
      }
      values.push(bare);
      i = j;
    }

    line.annotations.push({
      key,
      value: values.join(", "),
      values,
      from: line.from + keyStart,
      to: line.from + i,
    });

    const next = ws(raw, i);
    if (!atStop(raw, next)) {
      report(line, diagnostics, {
        from: line.from + next,
        to: line.to,
        severity: "error",
        message: "Expected “,”, “}”, or a # comment after the value.",
      });
      i = next;
      while (i < raw.length && raw[i] !== "," && raw[i] !== "}") i++;
    }
  }
}

/**
 * Scan a container starting at `raw[open] === "{"`. Inline form fills the
 * line's annotations and returns after `}`. Expanded form (nothing but
 * whitespace or a comment after `{`) sets `opensBlock`. A `{` with items
 * but no closing `}` is an error and never opens a block.
 */
export function scanContainer(
  line: Line,
  raw: string,
  open: number,
  diagnostics: Diagnostic[]
): number {
  const i = ws(raw, open + 1);
  if (i >= raw.length) {
    line.opensBlock = true;
    return i;
  }
  if (raw[i] === "#") {
    line.opensBlock = true;
    line.spans.comment = [line.from + i, line.to];
    return raw.length;
  }
  const { end, closed } = scanItems(line, raw, i, true, diagnostics);
  if (!closed && !line.spans.comment) {
    report(line, diagnostics, {
      from: line.from + open,
      to: line.to,
      severity: "error",
      message: "Unclosed “{”. Close the container on this line or put “{” last to expand it.",
    });
  } else if (!closed && line.spans.comment) {
    report(line, diagnostics, {
      from: line.from + open,
      to: line.spans.comment[0],
      severity: "error",
      message: "Unclosed “{” before the # comment.",
    });
  }
  return end;
}

/** Keys that may never live inside a preset: structure stays explicit. */
const PRESET_BANNED_KEYS = new Set(["strict", "optional", "forbidden", "preset"]);

/** Post-pass: duplicate keys and contradictory membership on one entry. */
export function validateEntryAttributes(lines: Line[], diagnostics: Diagnostic[]): void {
  for (const l of lines) {
    if (l.kind !== "folder" && l.kind !== "file" && l.kind !== "preset") continue;
    const seen = new Set<string>();
    for (const a of l.annotations) {
      if (seen.has(a.key)) {
        report(l, diagnostics, {
          from: a.from,
          to: a.to,
          severity: "error",
          message: `Duplicate “${a.key}” on this entry. Values never combine.`,
        });
      }
      seen.add(a.key);
    }
    if (seen.has("forbidden") && seen.has("optional")) {
      report(l, diagnostics, {
        from: l.spans.name?.[0] ?? l.from,
        to: l.spans.name?.[1] ?? l.to,
        severity: "error",
        message: "“forbidden” replaces presence rules. Drop the “?” (or “optional”), or drop “forbidden”.",
      });
    }
  }
}

/** Post-pass: build the preset map from definition lines. */
export function collectPresets(
  lines: Line[],
  diagnostics: Diagnostic[]
): Record<string, { expands: Record<string, string[] | null> }> {
  const presets: Record<string, { expands: Record<string, string[] | null> }> = {};
  for (const l of lines) {
    if (l.kind !== "preset" || !l.presetName) continue;
    if (presets[l.presetName]) {
      report(l, diagnostics, {
        from: l.spans.name![0],
        to: l.spans.name![1],
        severity: "error",
        message: `Preset “${l.presetName}” is defined twice.`,
      });
      continue;
    }
    const expands: Record<string, string[] | null> = {};
    for (const a of l.annotations) {
      if (PRESET_BANNED_KEYS.has(a.key)) {
        report(l, diagnostics, {
          from: a.from,
          to: a.to,
          severity: "error",
          message: `“${a.key}” cannot live in a preset. Structure and preset references stay explicit on entries.`,
        });
        continue;
      }
      expands[a.key] = a.value === null ? null : a.values;
    }
    presets[l.presetName] = { expands };
  }
  return presets;
}
