/**
 * Drafteine parser. Line based, indentation driven, error tolerant.
 *
 * Every line of the document becomes a `Line` record. Structural lines
 * (files and folders) are additionally linked into a tree. Invalid lines
 * are never dropped: they carry their errors with them so previews can
 * render them in place, degraded rather than missing.
 *
 * Grammar summary (see SPEC.md for the full version):
 *   line        := indent (comment | pragma | preset | entry)?
 *   indent      := ("  " | "\t")*          -- one unit = 2 spaces or 1 tab
 *   comment     := "#" .*
 *   pragma      := "drafteine" number      -- first content line only
 *   preset      := "preset" name container -- unindented
 *   entry       := path "/"? "?"? container? trailing-comment?
 *   path        := name ("/" name)*        -- one segment or a sparse path
 *   container   := "{" items "}"           -- inline, or expanded over lines
 *   item        := key ":" value | key     -- flags are bare words
 *
 * `#` is only syntax when preceded by whitespace, so `notes#1.md` is an
 * ordinary name. Attributes never trail bare: they live in the container.
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
  collectPresets,
  scanContainer,
  scanItems,
  validateEntryAttributes,
} from "./attributes.js";
import { applyProfiles } from "./profiles.js";
import {
  NAME_BOUNDARY_RE,
  QUOTED_NAME_RE,
  nameComplaint,
  unescape,
} from "./names.js";
export { needsQuoting, quoteName, quoteValue } from "./names.js";

/** Preset definitions look like `preset name { … }` on an unindented line. */
const PRESET_TRIGGER_RE = /^preset[ \t]+/;
const PRESET_NAME_RE = /^[A-Za-z][\w-]*/;

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
  // The line whose expanded `{ … }` container we are currently inside, if any.
  let blockOwner: Line | null = null;
  // False until the first non-blank, non-comment line: the pragma position.
  let seenContent = false;
  // Format version from a valid pragma. Absent means 1, permanently.
  let docVersion = 1;

  const ws = (raw: string, i: number): number => {
    while (raw[i] === " " || raw[i] === "\t") i++;
    return i;
  };

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

    // --- inside an expanded { } container --------------------------------
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
      line.kind = "annotation";
      line.depth = blockOwner.depth + 1;
      scanItems(line, raw, indentEnd, false, diagnostics);
      blockOwner.annotations.push(...line.annotations);
      continue;
    }

    if (rest.trimEnd() === "}") {
      line.kind = "block-end";
      addError(line, diagnostics, {
        from: line.from + indentEnd,
        to: line.to,
        severity: "error",
        message: "Unmatched “}”. There is no open container.",
      });
      continue;
    }

    // --- preset definition: unindented `preset name { … }` ----------------
    if (indentEnd === 0 && !rest.startsWith('"') && PRESET_TRIGGER_RE.test(rest)) {
      line.kind = "preset";
      let cursor = pos + rest.match(PRESET_TRIGGER_RE)![0].length;
      const nm = PRESET_NAME_RE.exec(raw.slice(cursor));
      if (!nm) {
        addError(line, diagnostics, {
          from: line.from + cursor,
          to: line.to,
          severity: "error",
          message: "Preset needs a name: “preset name { … }”.",
        });
        continue;
      }
      line.presetName = nm[0];
      line.name = nm[0];
      line.spans.name = [line.from + cursor, line.from + cursor + nm[0].length];
      cursor = ws(raw, cursor + nm[0].length);
      if (raw[cursor] === "{") {
        cursor = ws(raw, scanContainer(line, raw, cursor, diagnostics));
        if (raw[cursor] === "#") line.spans.comment = [line.from + cursor, line.to];
      } else {
        addError(line, diagnostics, {
          from: line.from + cursor,
          to: line.to,
          severity: "error",
          message: "Preset needs a “{ … }” container with its attributes.",
        });
      }
      if (line.opensBlock) blockOwner = line;
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

    // --- name, path, sigils ----------------------------------------------
    // Quoted form: a single literal segment, optionally `/` then `?`.
    // Bare form runs to the first whitespace-preceded `{` or `#`, or end
    // of line. `/` inside it makes a path line; trailing `?` marks the
    // leaf optional.
    let name: string;
    let nameEnd: number;
    let optionalSigil = false;
    const wasQuoted = rest.startsWith('"');
    if (wasQuoted) {
      const q = QUOTED_NAME_RE.exec(rest);
      if (q) {
        name = unescape(q[1]);
        let end = q[0].length;
        if (rest[end] === "/") {
          line.isFolder = true;
          end++;
        }
        if (rest[end] === "?") {
          optionalSigil = true;
          end++;
        }
        nameEnd = pos + end;
        if (name.includes("/")) {
          addError(line, diagnostics, {
            from: line.from + pos,
            to: line.from + nameEnd,
            severity: "error",
            message: "A quoted name is a single segment. Write paths unquoted.",
          });
        }
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
      const rawHead = (boundary ? boundary[1] : rest).trimEnd();
      nameEnd = pos + rawHead.length;
      let head = rawHead;
      if (head.endsWith("?")) {
        optionalSigil = true;
        head = head.slice(0, -1);
      }
      if (head.endsWith("/")) {
        line.isFolder = true;
        head = head.slice(0, -1);
      }
      name = head;
      if (name.includes("/")) {
        const segments = name.split("/");
        if (segments.some((s) => s === "")) {
          addError(line, diagnostics, {
            from: line.from + pos,
            to: line.from + nameEnd,
            severity: "error",
            message: "Empty path segment. Segments sit between single “/” separators.",
          });
        } else {
          line.path = segments;
          name = segments[segments.length - 1];
        }
      }
    }
    const nameSpan: [number, number] = [line.from + pos, line.from + nameEnd];
    line.name = name;
    line.kind = line.isFolder ? "folder" : "file";
    line.spans.name = nameSpan;

    for (const segment of line.path ?? [name]) {
      const complaint = nameComplaint(segment, line.isFolder);
      if (complaint) {
        addError(line, diagnostics, {
          from: nameSpan[0],
          to: Math.max(nameSpan[0] + 1, nameSpan[1]),
          severity: "error",
          message: complaint,
        });
        break;
      }
    }
    if (!wasQuoted && !line.path && /^drafteine[ \t]+[0-9]+$/.test(name)) {
      addError(line, diagnostics, {
        from: nameSpan[0],
        to: nameSpan[1],
        severity: "warning",
        message: `Looks like a version pragma, but only the first content line can be one. Parsed as a file named “${name}”. Quote the name if a file is intended.`,
      });
    }

    if (optionalSigil) {
      line.annotations.push({
        key: "optional",
        value: null,
        values: [],
        from: line.from + nameEnd - 1,
        to: line.from + nameEnd,
      });
    }

    // --- container and trailing comment ----------------------------------
    let cursor = ws(raw, nameEnd);
    if (raw[cursor] === "{") {
      cursor = ws(raw, scanContainer(line, raw, cursor, diagnostics));
    }
    if (raw[cursor] === "#") {
      line.spans.comment = [line.from + cursor, line.to];
    } else if (raw.slice(cursor).trim() !== "" && !line.spans.comment) {
      const stale = /^@[A-Za-z]/.test(raw.slice(cursor));
      addError(line, diagnostics, {
        from: line.from + cursor,
        to: line.to,
        severity: "error",
        message: stale
          ? "Trailing “@key” annotations are pre-release syntax. Attributes go in a “{ … }” container."
          : "Expected “{ attributes }” or a # comment after the name.",
      });
    }

    // --- link into the tree --------------------------------------------
    stack.length = depth + 1;
    let parent = stack[depth];
    let chainBroken = false;
    for (const segment of (line.path ?? []).slice(0, -1)) {
      const existing = parent.children.find((c) => c.name === segment);
      if (existing && existing.isFolder) {
        parent = existing;
        continue;
      }
      if (existing) {
        addError(line, diagnostics, {
          from: nameSpan[0],
          to: nameSpan[1],
          severity: "error",
          message: `“${segment}” is already declared as a file. A path cannot pass through it.`,
        });
        chainBroken = true;
        break;
      }
      const implied: TreeNode = {
        kind: "folder",
        name: segment,
        depth,
        isFolder: true,
        annotations: [],
        children: [],
        line,
        parent,
      };
      parent.children.push(implied);
      parent = implied;
    }
    if (chainBroken) {
      prevStructural = line;
      continue;
    }

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
      message: "Unclosed “{” container. Expected a closing “}”.",
    });
  }

  validateEntryAttributes(lines, diagnostics);
  const presets = collectPresets(lines, diagnostics);

  const result: ParseResult = {
    lines,
    root,
    diagnostics,
    stats: { folders: 0, files: 0, errors: 0, warnings: 0 },
    indentUnit: docIndentUnit || INDENT_UNIT,
    version: docVersion,
    presets,
  };
  applyProfiles(result);

  const stats: Stats = result.stats;
  for (const l of lines) {
    if (l.kind === "folder") stats.folders++;
    if (l.kind === "file") stats.files++;
  }
  for (const d of diagnostics) {
    if (d.severity === "error") stats.errors++;
    else if (d.severity === "warning") stats.warnings++;
  }
  return result;
}

export function addError(line: Line, diagnostics: Diagnostic[], diag: Diagnostic): void {
  line.errors.push(diag);
  diagnostics.push(diag);
}
