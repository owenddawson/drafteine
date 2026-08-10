/**
 * CodeMirror 6 integration for the Drafteine tree language:
 * a parse-backed state field, semantic decorations, lint diagnostics,
 * and the smart Tab / Enter behavior from the pitch.
 */
import {
  EditorState,
  StateField,
  RangeSetBuilder,
  type Line,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { linter, lintGutter } from "@codemirror/lint";
import { parse, INDENT_UNIT, type ParseResult } from "@drafteine/core";

/** Reparse on every doc change; small documents make this instant. */
export const parseField = StateField.define<ParseResult>({
  create: (state) => parse(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? parse(tr.newDoc.toString()) : value),
});

const mark = {
  folder: Decoration.mark({ class: "df-folder" }),
  file: Decoration.mark({ class: "df-file" }),
  ext: Decoration.mark({ class: "df-ext" }),
  slash: Decoration.mark({ class: "df-slash" }),
  annotation: Decoration.mark({ class: "df-annotation" }),
  comment: Decoration.mark({ class: "df-comment" }),
};

const decorationField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state.field(parseField)),
  update: (value, tr) =>
    tr.docChanged ? buildDecorations(tr.state.field(parseField)) : value,
  provide: (f) => EditorView.decorations.from(f),
});

function buildDecorations(result: ParseResult): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const line of result.lines) {
    if (line.kind === "comment") {
      const [from, to] = line.spans.comment!;
      if (from < to) builder.add(from, to, mark.comment);
      continue;
    }
    if (line.kind === "annotation") {
      for (const a of line.annotations) builder.add(a.from, a.to, mark.annotation);
      if (line.spans.comment) {
        const [from, to] = line.spans.comment;
        if (from < to) builder.add(from, to, mark.comment);
      }
      continue;
    }
    if (line.kind === "pragma") {
      const end = line.spans.version ? line.spans.version[1] : line.to;
      if (line.from < end) builder.add(line.from, end, mark.annotation);
      if (line.spans.comment) {
        const [from, to] = line.spans.comment;
        if (from < to) builder.add(from, to, mark.comment);
      }
      continue;
    }
    if (line.kind !== "folder" && line.kind !== "file") continue;

    const [nameFrom, nameTo] = line.spans.name!;
    if (line.kind === "folder") {
      // name + trailing slash, styled separately so the slash reads as syntax
      if (nameFrom < nameTo - 1) builder.add(nameFrom, nameTo - 1, mark.folder);
      builder.add(nameTo - 1, nameTo, mark.slash);
    } else if (nameFrom < nameTo) {
      const dot = line.name.lastIndexOf(".");
      const extFrom = dot > 0 ? nameFrom + dot : nameTo;
      if (nameFrom < extFrom) builder.add(nameFrom, extFrom, mark.file);
      if (extFrom < nameTo) builder.add(extFrom, nameTo, mark.ext);
    }
    for (const a of line.annotations) builder.add(a.from, a.to, mark.annotation);
    if (line.spans.comment) {
      const [from, to] = line.spans.comment;
      if (from < to) builder.add(from, to, mark.comment);
    }
  }
  return builder.finish();
}

const drafteineLinter = linter(
  (view) =>
    view.state.field(parseField).diagnostics.map((d) => ({
      from: d.from,
      to: Math.min(d.to, view.state.doc.length),
      severity: d.severity,
      message: d.message,
    })),
  { delay: 120 }
);

/* ---------------- smart indentation ---------------------------------- */

function lineIndentInfo(
  state: EditorState,
  lineNo: number
): { depth: number; isFolder: boolean } | null {
  const parsed = state.field(parseField);
  // Walk upward to the nearest structural line above this one.
  for (let i = lineNo - 1; i >= 0; i--) {
    const l = parsed.lines[i];
    if (l && (l.kind === "folder" || l.kind === "file")) {
      return { depth: l.depth, isFolder: l.isFolder };
    }
  }
  return null;
}

function currentIndentUnits(text: string): number {
  let units = 0;
  let pos = 0;
  while (text.startsWith("  ", pos) || text[pos] === "\t") {
    pos += text[pos] === "\t" ? 1 : 2;
    units++;
  }
  return units;
}

function reindentLine(view: EditorView, line: Line, units: number): boolean {
  const text = line.text;
  let end = 0;
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
  view.dispatch({
    changes: {
      from: line.from,
      to: line.from + end,
      insert: " ".repeat(units * INDENT_UNIT),
    },
  });
  return true;
}

/** Tab: indent one level, capped at (previous structural line depth + 1 if folder). */
function smartIndent(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const above = lineIndentInfo(state, line.number - 1);
  const max = above ? above.depth + (above.isFolder ? 1 : 0) : 0;
  const cur = currentIndentUnits(line.text);
  return reindentLine(view, line, Math.min(cur + 1, max));
}

function smartDedent(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const cur = currentIndentUnits(line.text);
  if (cur === 0) return true;
  return reindentLine(view, line, cur - 1);
}

/** Enter: new line inherits indentation; a folder line opens one level deeper. */
function smartNewline(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const parsed = state.field(parseField);
  const cur = parsed.lines[line.number - 1];
  let units = currentIndentUnits(line.text);
  if (cur && cur.kind === "folder" && cur.errors.length === 0 && pos === line.to) {
    units += 1;
  }
  const insert = "\n" + " ".repeat(units * INDENT_UNIT);
  view.dispatch({
    changes: { from: pos, to: state.selection.main.to, insert },
    selection: { anchor: pos + insert.length },
    scrollIntoView: true,
  });
  return true;
}

const drafteineKeymap = keymap.of([
  { key: "Tab", run: smartIndent, shift: smartDedent },
  { key: "Enter", run: smartNewline },
  ...defaultKeymap,
  ...historyKeymap,
]);

/* ---------------- assembly ------------------------------------------- */

/* Registered as a real CodeMirror theme (not plain CSS) so it outranks the
   library's light base theme, and `dark: true` flips its defaults too. */
const espressoTheme = EditorView.theme(
  {
    "&": { backgroundColor: "var(--bg)", color: "var(--ink)" },
    ".cm-gutters": {
      backgroundColor: "var(--bg)",
      color: "var(--faint)",
      borderRight: "1px solid var(--line)",
    },
  },
  { dark: true }
);

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  onParse: (result: ParseResult) => void;
}

export function createEditor({ parent, doc, onParse }: EditorOptions): EditorView {
  let lastParse: ParseResult | null = null;
  const notify = EditorView.updateListener.of((update) => {
    if (update.docChanged || update.state.field(parseField) !== lastParse) {
      lastParse = update.state.field(parseField);
      onParse(lastParse);
    }
  });

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        espressoTheme,
        parseField,
        decorationField,
        drafteineLinter,
        lintGutter(),
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drafteineKeymap,
        EditorView.lineWrapping,
        notify,
      ],
    }),
  });

  lastParse = view.state.field(parseField);
  onParse(lastParse);
  return view;
}
