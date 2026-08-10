#!/usr/bin/env node
/**
 * Drafteine language server. LSP over stdio.
 *
 * One implementation serves every LSP client (VS Code, JetBrains, Neovim,
 * Helix, Zed …): push diagnostics from the parser, whole-document
 * formatting via the canonical formatter, attribute completions inside
 * `{ }` containers, and hover docs from the attribute vocabulary.
 */
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
  TextEdit,
  SymbolKind,
  CodeActionKind,
  type CodeAction,
  type InitializeResult,
  type CompletionItem,
  type Hover,
  type Diagnostic,
  type DocumentSymbol,
  type FoldingRange,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, format, type ParseResult, type TreeNode } from "@drafteine/core";
import { ANNOTATIONS, hoverDoc, type AnnotationDoc } from "./annotations.js";
import { CONFIG_KEY_DOCS, configFoldingRanges, formatConfig, isConfigDoc, validateConfig } from "./configcheck.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

/* ---------------- declared vocabulary ---------------------------------
 * Projects declare custom annotations in drafteine.config.json (or the
 * package.json "drafteine" key):
 *   { "annotations": [
 *       { "name": "owner", "value": "string", "doc": "Team that owns this." }
 *   ] }
 * Declared annotations complete and hover like built ins. Check treats
 * them as inert metadata. */

let workspaceRoots: string[] = [];
const vocabCache = new Map<string, { mtime: number; vocab: Record<string, AnnotationDoc> }>();

function readVocabFile(file: string, fromKey: boolean): Record<string, AnnotationDoc> {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return {};
  }
  const hit = vocabCache.get(file);
  if (hit && hit.mtime === stat.mtimeMs) return hit.vocab;

  const vocab: Record<string, AnnotationDoc> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const cfg = fromKey ? (parsed.drafteine as Record<string, unknown> | undefined) : parsed;
    const list = cfg?.annotations;
    if (Array.isArray(list)) {
      for (const entry of list) {
        const e = entry as { name?: string; doc?: string; value?: string; appliesTo?: string };
        if (!e.name || !/^[A-Za-z][\w-]*$/.test(e.name)) continue;
        const takesValue = e.value !== undefined && e.value !== "flag";
        vocab[e.name] = {
          snippet: takesValue ? `${e.name}: $1` : e.name,
          doc: [
            `**${e.name}${takesValue ? `: ${e.value}` : ""}**`,
            "",
            e.doc ?? "Custom annotation declared by this project.",
            "",
            `Declared in ${path.basename(file)}. Tools treat it as metadata.`,
          ].join("\n"),
          appliesTo:
            e.appliesTo === "file" || e.appliesTo === "folder" ? e.appliesTo : "both",
        };
      }
    }
  } catch {
    // Malformed config: the check watcher reports it, the server stays quiet.
  }
  vocabCache.set(file, { mtime: stat.mtimeMs, vocab });
  return vocab;
}

function customAnnotations(): Record<string, AnnotationDoc> {
  const merged: Record<string, AnnotationDoc> = {};
  for (const root of workspaceRoots) {
    Object.assign(merged, readVocabFile(path.join(root, "package.json"), true));
    Object.assign(merged, readVocabFile(path.join(root, "drafteine.config.json"), false));
  }
  return merged;
}

/** Cache the parse per document version so hover/completion reuse it. */
const parseCache = new Map<string, { version: number; result: ParseResult }>();

function parsed(doc: TextDocument): ParseResult {
  const hit = parseCache.get(doc.uri);
  if (hit && hit.version === doc.version) return hit.result;
  const result = parse(doc.getText());
  parseCache.set(doc.uri, { version: doc.version, result });
  return result;
}

connection.onInitialize((params): InitializeResult => {
  workspaceRoots =
    params.workspaceFolders?.map((f) => fileURLToPath(f.uri)) ??
    (params.rootUri ? [fileURLToPath(params.rootUri)] : []);
  return {
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: { triggerCharacters: ["{", ","] },
    hoverProvider: true,
    documentFormattingProvider: true,
    documentSymbolProvider: true,
    foldingRangeProvider: true,
    codeActionProvider: true,
  },
  };
});

documents.onDidChangeContent((change) => {
  const doc = change.document;
  if (isConfigDoc(doc)) {
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: validateConfig(doc) });
    return;
  }
  const result = parsed(doc);
  const diagnostics: Diagnostic[] = result.diagnostics.map((d) => ({
    range: {
      start: doc.positionAt(d.from),
      end: doc.positionAt(Math.min(d.to, doc.getText().length)),
    },
    severity:
      d.severity === "error"
        ? DiagnosticSeverity.Error
        : d.severity === "warning"
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Information,
    message: d.message,
    source: "drafteine",
  }));
  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
});

documents.onDidClose((e) => {
  parseCache.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onCompletion((params): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  if (isConfigDoc(doc)) {
    return Object.entries(CONFIG_KEY_DOCS).map(([key, docText]) => ({
      label: key,
      kind: CompletionItemKind.Property,
      insertText: key,
      documentation: { kind: MarkupKind.Markdown, value: docText },
    }));
  }
  const result = parsed(doc);
  const line = result.lines[params.position.line];
  const isFolder = line?.isFolder ?? false;
  const before = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: params.position,
  });

  // Attribute completions apply inside a container: after an unclosed `{`
  // on this line, or on an item line of an expanded container.
  const inContainer =
    before.lastIndexOf("{") > before.lastIndexOf("}") || line?.kind === "annotation";
  if (!inContainer) return [];

  // After `preset:`, offer the presets defined in this draft.
  if (/preset\s*:\s*[\w-]*$/.test(before)) {
    return Object.keys(result.presets).map((name) => ({
      label: name,
      kind: CompletionItemKind.Value,
      documentation: {
        kind: MarkupKind.Markdown,
        value: `Preset defined in this draft. Expands to: \`${Object.entries(
          result.presets[name].expands
        )
          .map(([k, v]) => (v === null ? k : `${k}: ${v.join(", ")}`))
          .join(", ")}\``,
      },
    }));
  }

  return Object.entries({ ...ANNOTATIONS, ...customAnnotations() })
    .filter(([, a]) => a.appliesTo === "both" || a.appliesTo === (isFolder ? "folder" : "file"))
    .map(([key, a]) => ({
      label: key,
      kind: CompletionItemKind.Property,
      insertText: a.snippet,
      insertTextFormat: InsertTextFormat.Snippet,
      documentation: { kind: MarkupKind.Markdown, value: a.doc },
      filterText: key,
    }));
});

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || isConfigDoc(doc)) return null;
  const offset = doc.offsetAt(params.position);
  const result = parsed(doc);
  const line = result.lines[params.position.line];
  if (!line) return null;

  if (line.kind === "pragma" && line.version !== undefined) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value:
          `**drafteine ${line.version}**\n\nFormat version pragma. Declares which ` +
          `Drafteine format this draft is written in. Optional: a draft without ` +
          `one is read as format 1. Only the first content line can be a pragma.`,
      },
      range: {
        start: doc.positionAt(line.from),
        end: doc.positionAt(line.spans.version ? line.spans.version[1] : line.to),
      },
    };
  }

  const ann = line.annotations.find((a) => offset >= a.from && offset <= a.to);
  if (ann) {
    const md = hoverDoc(ann.key) ?? customAnnotations()[ann.key]?.doc;
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: md ?? `**${ann.key}**\n\nUnknown attribute. It is parsed and carried through, and tools ignore it.`,
      },
      range: { start: doc.positionAt(ann.from), end: doc.positionAt(ann.to) },
    };
  }

  // Hovering the entry itself: describe what this line declares.
  const span = line.spans.name;
  if (span && offset >= span[0] && offset <= span[1] && line.node) {
    const node = line.node;
    const segments: string[] = [];
    for (let n: typeof node | undefined = node; n && n.kind !== "root"; n = n.parent) {
      segments.unshift(n.name + (n.isFolder ? "/" : ""));
    }
    const parts = [
      `**${node.name}${node.isFolder ? "/" : ""}** (${node.isFolder ? "folder" : "file"})`,
      `path: \`${segments.join("")}\``,
    ];
    if (node.isFolder) {
      parts.push(`${node.children.length} declared ${node.children.length === 1 ? "child" : "children"}`);
    }
    if (node.annotations.length > 0) {
      parts.push(
        node.annotations
          .map((a) => `\`${a.key}${a.value !== null ? `: ${a.value}` : ""}\``)
          .join(" · ")
      );
    }
    return {
      contents: { kind: MarkupKind.Markdown, value: parts.join("\n\n") },
      range: { start: doc.positionAt(span[0]), end: doc.positionAt(span[1]) },
    };
  }
  return null;
});

connection.onDocumentFormatting((params): TextEdit[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  if (isConfigDoc(doc)) {
    const text = doc.getText();
    const formatted = formatConfig(text);
    if (formatted === null || formatted === text) return [];
    return [
      TextEdit.replace(
        { start: doc.positionAt(0), end: doc.positionAt(text.length) },
        formatted
      ),
    ];
  }
  const text = doc.getText();
  const formatted = format(text);
  if (formatted === text) return [];
  return [
    TextEdit.replace(
      { start: doc.positionAt(0), end: doc.positionAt(text.length) },
      formatted
    ),
  ];
});

/** Last structural line number in a node's subtree (for folding/symbols). */
function subtreeEndLine(node: TreeNode): number {
  let end = node.line?.lineNo ?? 0;
  for (const child of node.children) end = Math.max(end, subtreeEndLine(child));
  return end;
}

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || isConfigDoc(doc)) return [];
  const result = parsed(doc);

  const toSymbol = (node: TreeNode): DocumentSymbol => {
    const line = node.line!;
    const start = { line: line.lineNo, character: 0 };
    // The end character must be a real column. LSP positions are uintegers
    // capped at 2^31-1, and an oversized value fails the client's
    // DocumentSymbol validation, which then misreads the whole response
    // as flat SymbolInformation and crashes on the missing location.
    const endLine = subtreeEndLine(node);
    const end = {
      line: endLine,
      character: result.lines[endLine]?.raw.length ?? 0,
    };
    return {
      name: node.name + (node.isFolder ? "/" : ""),
      kind: node.isFolder ? SymbolKind.Package : SymbolKind.File,
      range: { start, end },
      selectionRange: {
        start: doc.positionAt(line.spans.name?.[0] ?? line.from),
        end: doc.positionAt(line.spans.name?.[1] ?? line.to),
      },
      children: node.children.map(toSymbol),
    };
  };
  return result.root.children.map(toSymbol);
});

connection.onFoldingRanges((params): FoldingRange[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  if (isConfigDoc(doc)) return configFoldingRanges(doc.getText());
  const result = parsed(doc);
  const ranges: FoldingRange[] = [];

  const walk = (node: TreeNode): void => {
    for (const child of node.children) {
      if (child.isFolder && child.children.length > 0) {
        ranges.push({
          startLine: child.line!.lineNo,
          endLine: subtreeEndLine(child),
        });
        walk(child);
      }
    }
  };
  walk(result.root);
  return ranges;
});

connection.onCodeAction((params): CodeAction[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || isConfigDoc(doc)) return [];
  const result = parsed(doc);
  const actions: CodeAction[] = [];

  for (const d of params.context.diagnostics) {
    if (/Indentation should be a multiple|Mixed tabs and spaces/.test(d.message)) {
      const lineNo = d.range.start.line;
      const line = result.lines[lineNo];
      if (!line) continue;
      let ws = 0;
      while (ws < line.raw.length && (line.raw[ws] === " " || line.raw[ws] === "\t")) ws++;
      actions.push({
        title: "Fix indentation",
        kind: CodeActionKind.QuickFix,
        diagnostics: [d],
        edit: {
          changes: {
            [params.textDocument.uri]: [
              TextEdit.replace(
                { start: { line: lineNo, character: 0 }, end: { line: lineNo, character: ws } },
                " ".repeat(line.depth * result.indentUnit)
              ),
            ],
          },
        },
      });
    }
    const dup = /^Duplicate “([\w-]+)”/.exec(d.message);
    if (dup) {
      const start = { ...d.range.start };
      if (start.character > 0) start.character -= 1; // take the leading space too
      actions.push({
        title: `Remove duplicate “${dup[1]}”`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [d],
        edit: {
          changes: {
            [params.textDocument.uri]: [TextEdit.del({ start, end: d.range.end })],
          },
        },
      });
    }
  }
  return actions;
});

documents.listen(connection);
connection.listen();
