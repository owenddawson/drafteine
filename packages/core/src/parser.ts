/**
 * Drafteine parser. Line based, indentation driven, error tolerant.
 *
 * Every line of the document becomes a `Line` record. Structural lines
 * (files and folders) are additionally linked into a tree. Invalid lines
 * are never dropped: they carry their errors with them so previews can
 * render them in place, degraded rather than missing.
 *
 * Grammar summary (see SPEC.md for the full version):
 *   line        := indent (comment | entry)?
 *   indent      := ("  " | "\t")*          -- one unit = 2 spaces or 1 tab
 *   comment     := "#" .*
 *   pragma      := "drafteine" number      -- first content line only
 *   entry       := name "/"? annotation* trailing-comment?
 *   annotation  := whitespace "@" word ("(" value ")")?
 *
 * `@` and `#` are only syntax when preceded by whitespace, so `@types/` and
 * `file@2x.png` are ordinary names.
 */

import {
  INDENT_UNIT,
  type Diagnostic,
  type Line,
  type ParseResult,
  type Stats,
  type TreeNode,
} from "./types.js";
import { scanPragma } from "./pragma.js";
import {
  FORBIDDEN_NAME_CHARS,
  NAME_BOUNDARY_RE,
  QUOTED_NAME_RE,
  unescape,
} from "./names.js";
export { needsQuoting, quoteName, quoteValue } from "./names.js";

/** Annotation key: @word. Values are scanned by scanAnnotation. */
const ANNOTATION_KEY_RE = /^@([A-Za-z][\w-]*)/;

/**
 * Scan one annotation at raw[cursor]: @key, @key(value), or
 * @key(item, "quoted item", other). Returns null when malformed.
 */
function scanAnnotation(
  raw: string,
  cursor: number
): { key: string; value: string | null; values: string[]; end: number } | null {
  const m = ANNOTATION_KEY_RE.exec(raw.slice(cursor));
  if (!m) return null;
  let i = cursor + m[0].length;
  if (raw[i] !== "(") return { key: m[1], value: null, values: [], end: i };
  i++;
  const items: string[] = [];
  for (;;) {
    while (raw[i] === " ") i++;
    if (raw[i] === ")") {
      i++;
      break;
    }
    if (i >= raw.length) return null;
    if (raw[i] === '"') {
      const q = QUOTED_NAME_RE.exec(raw.slice(i));
      if (!q) return null;
      items.push(unescape(q[1]));
      i += q[0].length;
    } else {
      let j = i;
      while (j < raw.length && raw[j] !== "," && raw[j] !== ")") j++;
      if (j >= raw.length) return null;
      const item = raw.slice(i, j).trim();
      if (item !== "") items.push(item);
      i = j;
    }
    while (raw[i] === " ") i++;
    if (raw[i] === ",") {
      i++;
      continue;
    }
    if (raw[i] === ")") {
      i++;
      break;
    }
    return null;
  }
  const value = items.length === 0 ? "" : items.join(", ");
  return { key: m[1], value, values: items, end: i };
}
export function parse(text: string): ParseResult {
  const rawLines = text.split("\n");
  const lines: Line[] = [];
  const diagnostics: Diagnostic[] = [];
  const root: TreeNode = {
    kind: "root",
    name: "",
    depth: -1,
    isFolder: true,
    annotations: [],
    children: [],
    line: null,
  };

  // Stack of open ancestors. stack[d] is the current folder at depth d-1.
  const stack: TreeNode[] = [root];
  let prevStructural: Line | null = null;
  let offset = 0; // absolute character offset of the current line start
  // The document's spaces-per-level, inferred from the first space-indented
  // structural line (so pasted 4-space trees parse cleanly). 0 = not yet known.
  let docIndentUnit = 0;
  // The entry line whose `{ … }` block we are currently inside, if any.
  let blockOwner: Line | null = null;
  // False until the first non-blank, non-comment line: the pragma position.
  let seenContent = false;
  // Format version from a valid pragma. Absent means 1, permanently.
  let docVersion = 1;

  /** Scan annotations / trailing comment / `{` after a name or on a block line. */
  function scanTrailer(line: Line, raw: string, start: number, allowBrace: boolean): void {
    let cursor = start;
    while (cursor < raw.length) {
      if (raw[cursor] === " ") {
        cursor++;
        continue;
      }
      if (raw[cursor] === "#") {
        line.spans.comment = [line.from + cursor, line.to];
        return;
      }
      if (allowBrace && raw[cursor] === "{") {
        line.opensBlock = true;
        const after = raw.slice(cursor + 1).trimStart();
        if (after.startsWith("#")) {
          const at = raw.indexOf("#", cursor + 1);
          line.spans.comment = [line.from + at, line.to];
        } else if (after !== "") {
          addError(line, diagnostics, {
            from: line.from + cursor + 1,
            to: line.to,
            severity: "error",
            message: "“{” must end the line.",
          });
        }
        return;
      }
      if (raw[cursor] === "@") {
        const a = scanAnnotation(raw, cursor);
        if (a) {
          line.annotations.push({
            key: a.key,
            value: a.value,
            values: a.values,
            from: line.from + cursor,
            to: line.from + a.end,
          });
          cursor = a.end;
          continue;
        }
      }
      addError(line, diagnostics, {
        from: line.from + cursor,
        to: line.to,
        severity: "error",
        message: allowBrace
          ? "Expected @annotation, “{”, or # comment after the name."
          : "Expected @annotation, “}”, or # comment inside the block.",
      });
      return;
    }
  }

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const line: Line = {
      lineNo: i,
      from: offset,
      to: offset + raw.length,
      raw,
      kind: "blank",
      depth: 0,
      name: "",
      isFolder: false,
      annotations: [],
      errors: [],
      spans: {},
    };
    offset += raw.length + 1;
    lines.push(line);

    // --- indentation ---------------------------------------------------
    let pos = 0;
    let tabUnits = 0;
    let spaceCount = 0;
    let mixed = false;
    while (pos < raw.length) {
      if (raw[pos] === "\t") {
        tabUnits++;
        if (spaceCount > 0) mixed = true;
        pos++;
      } else if (raw[pos] === " ") {
        spaceCount++;
        pos++;
      } else {
        break;
      }
    }
    const indentEnd = pos;
    const rest = raw.slice(pos);

    if (rest.trim() === "") {
      line.kind = "blank";
      continue;
    }

    if (rest.startsWith("#")) {
      line.kind = "comment";
      line.spans.comment = [line.from + pos, line.to];
      continue;
    }

    // --- version pragma: first content line only -------------------------
    if (!seenContent && indentEnd === 0 && scanPragma(line, raw, pos, diagnostics)) {
      seenContent = true;
      if (line.version !== undefined) docVersion = line.version;
      continue;
    }
    seenContent = true;

    // --- inside a { } block --------------------------------------------
    if (blockOwner) {
      const trimmed = rest.trimEnd();
      if (trimmed.startsWith("}")) {
        line.kind = "block-end";
        line.depth = blockOwner.depth;
        if (trimmed !== "}") {
          addError(line, diagnostics, {
            from: line.from + indentEnd + 1,
            to: line.to,
            severity: "error",
            message: "“}” must be alone on its line.",
          });
        }
        blockOwner = null;
        continue;
      }
      if (rest.startsWith("@")) {
        line.kind = "annotation";
        line.depth = blockOwner.depth + 1;
        scanTrailer(line, raw, indentEnd, false);
        blockOwner.annotations.push(...line.annotations);
        continue;
      }
      addError(line, diagnostics, {
        from: line.from + indentEnd,
        to: line.to,
        severity: "error",
        message: `Expected @annotation or “}” in the block of “${blockOwner.name}”. Closing the block.`,
      });
      blockOwner = null;
      // fall through: parse this line as a normal entry (recovery)
    }

    if (rest.trimEnd() === "}") {
      line.kind = "block-end";
      addError(line, diagnostics, {
        from: line.from + indentEnd,
        to: line.to,
        severity: "error",
        message: "Unmatched “}”. There is no open block.",
      });
      continue;
    }

    // First space-indented structural line fixes the document's indent
    // unit, so pasted 4-space (or 3-space) trees parse cleanly.
    if (!mixed && docIndentUnit === 0 && spaceCount > 0) {
      docIndentUnit = spaceCount <= 8 ? spaceCount : INDENT_UNIT;
    }
    const unit = docIndentUnit || INDENT_UNIT;
    const units = tabUnits + Math.floor(spaceCount / unit);
    if (mixed) {
      addError(line, diagnostics, {
        from: line.from,
        to: line.from + indentEnd,
        severity: "warning",
        message: "Mixed tabs and spaces in indentation.",
      });
    } else if (spaceCount % unit !== 0) {
      addError(line, diagnostics, {
        from: line.from,
        to: line.from + indentEnd,
        severity: "warning",
        message: `Indentation should be a multiple of ${unit} spaces; rounding down.`,
      });
    }

    // --- depth: clamp instead of failing -------------------------------
    let depth = units;
    const maxDepth = prevStructural
      ? prevStructural.depth + (prevStructural.isFolder ? 1 : 0)
      : 0;
    if (depth > maxDepth) {
      const reason =
        prevStructural && !prevStructural.isFolder && depth > prevStructural.depth
          ? `“${prevStructural.name}” is a file. Files cannot contain children.`
          : `Over-indented: nothing at this position is one level up.`;
      addError(line, diagnostics, {
        from: line.from,
        to: line.from + indentEnd,
        severity: "error",
        message: reason + ` Treating as depth ${maxDepth}.`,
      });
      depth = maxDepth;
    }
    line.depth = depth;

    // --- name ----------------------------------------------------------
    // Quoted form: "anything \" escaped", optionally followed by `/`.
    // Bare form runs to the first whitespace-preceded @ or #, or end of
    // line, so `@types/` and `file@2x.png` parse as names.
    let name: string;
    let nameEnd: number;
    if (rest.startsWith('"')) {
      const q = QUOTED_NAME_RE.exec(rest);
      if (q) {
        name = unescape(q[1]);
        let end = q[0].length;
        if (rest[end] === "/") {
          line.isFolder = true;
          end++;
        }
        nameEnd = pos + end;
      } else {
        // Strip the opening quote so the forbidden-`"` rule doesn't
        // pile a second diagnostic onto the same mistake.
        name = rest.slice(1).trimEnd();
        nameEnd = pos + rest.trimEnd().length;
        addError(line, diagnostics, {
          from: line.from + pos,
          to: line.to,
          severity: "error",
          message: "Unterminated quoted name.",
        });
      }
    } else {
      const boundary = NAME_BOUNDARY_RE.exec(rest);
      name = (boundary ? boundary[1] : rest).trimEnd();
      nameEnd = pos + name.length;
      if (name.endsWith("/")) {
        line.isFolder = true;
        name = name.slice(0, -1);
      }
    }
    const nameSpan: [number, number] = [line.from + pos, line.from + nameEnd];
    line.name = name;
    line.kind = line.isFolder ? "folder" : "file";
    line.spans.name = nameSpan;

    if (name === "") {
      addError(line, diagnostics, {
        from: nameSpan[0],
        to: Math.max(nameSpan[0] + 1, nameSpan[1]),
        severity: "error",
        message: line.isFolder
          ? "Folder has no name."
          : "Expected a file or folder name.",
      });
    } else if (name === "." || name === "..") {
      addError(line, diagnostics, {
        from: nameSpan[0],
        to: nameSpan[1],
        severity: "error",
        message: `“${name}” is not a valid name. It refers to a directory position, not an entry.`,
      });
    } else if (FORBIDDEN_NAME_CHARS.test(name)) {
      addError(line, diagnostics, {
        from: nameSpan[0],
        to: nameSpan[1],
        severity: "error",
        message: `Name contains a character not allowed in paths: ${
          name.match(FORBIDDEN_NAME_CHARS)![0]
        }`,
      });
    } else if (name.includes("/")) {
      addError(line, diagnostics, {
        from: nameSpan[0],
        to: nameSpan[1],
        severity: "error",
        message: "“/” can only appear at the end of a folder name.",
      });
    } else if (!rest.startsWith('"') && /^drafteine[ \t]+[0-9]+$/.test(name)) {
      addError(line, diagnostics, {
        from: nameSpan[0],
        to: nameSpan[1],
        severity: "warning",
        message: `Looks like a version pragma, but only the first content line can be one. Parsed as a file named “${name}”. Quote the name if a file is intended.`,
      });
    }

    // --- annotations, trailing comment, optional `{` --------------------
    scanTrailer(line, raw, nameEnd, true);

    // --- link into the tree --------------------------------------------
    stack.length = depth + 1;
    const parent = stack[depth];
    const node: TreeNode = {
      kind: line.kind,
      name,
      depth,
      isFolder: line.isFolder,
      annotations: line.annotations,
      children: [],
      line,
      parent,
    };
    line.node = node;

    if (name !== "") {
      const twin = parent.children.find(
        (c) => c.name.toLowerCase() === name.toLowerCase()
      );
      if (twin && twin.name === name) {
        addError(line, diagnostics, {
          from: nameSpan[0],
          to: nameSpan[1],
          severity: "warning",
          message: `Duplicate name “${name}” among siblings.`,
        });
      } else if (twin) {
        addError(line, diagnostics, {
          from: nameSpan[0],
          to: nameSpan[1],
          severity: "warning",
          message: `“${name}” differs only by letter case from sibling “${twin.name}”. Case-insensitive filesystems treat them as the same entry.`,
        });
      }
    }
    parent.children.push(node);
    if (line.isFolder) stack[depth + 1] = node;
    prevStructural = line;
    if (line.opensBlock) blockOwner = line;
  }

  if (blockOwner) {
    addError(blockOwner, diagnostics, {
      from: blockOwner.from,
      to: blockOwner.to,
      severity: "error",
      message: "Unclosed “{” block. Expected a closing “}”.",
    });
  }

  for (const l of lines) {
    if (l.kind !== "folder" && l.kind !== "file") continue;
    const seen = new Set<string>();
    for (const a of l.annotations) {
      if (seen.has(a.key)) {
        addError(l, diagnostics, {
          from: a.from,
          to: a.to,
          severity: "error",
          message: `Duplicate @${a.key} on this entry. Defaults never combine.`,
        });
      }
      seen.add(a.key);
    }
  }

  const stats: Stats = { folders: 0, files: 0, errors: 0, warnings: 0 };
  for (const l of lines) {
    if (l.kind === "folder") stats.folders++;
    if (l.kind === "file") stats.files++;
  }
  for (const d of diagnostics) {
    if (d.severity === "error") stats.errors++;
    else if (d.severity === "warning") stats.warnings++;
  }

  return {
    lines,
    root,
    diagnostics,
    stats,
    indentUnit: docIndentUnit || INDENT_UNIT,
    version: docVersion,
  };
}

export function addError(line: Line, diagnostics: Diagnostic[], diag: Diagnostic): void {
  line.errors.push(diag);
  diagnostics.push(diag);
}
