/**
 * Drafteine VS Code extension. A thin client over the language server,
 * plus the two things LSP can't carry: the live tree preview (webview)
 * and one-click materialization via the workspace filesystem API.
 */
import * as path from "node:path";
import {
  window,
  workspace,
  commands,
  ViewColumn,
  Range,
  type ExtensionContext,
  type WebviewPanel,
} from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";
import * as fs from "node:fs";
import { parse, runApply, type ApplyIO, type ParseResult, type Line, type TreeNode } from "@drafteine/core";
import { activateCheck } from "./check";

let client: LanguageClient | undefined;
let panel: WebviewPanel | undefined;

export function activate(
  context: ExtensionContext
): { extendMarkdownIt: typeof extendMarkdownIt } {
  activateCheck(context);
  try {
    fileColorsCss = fs.readFileSync(
      context.asAbsolutePath(path.join("media", "filecolors.css")),
      "utf8"
    );
  } catch {
    fileColorsCss = ""; // preview still works, files just stay neutral
  }
  context.subscriptions.push(
    commands.registerCommand("drafteine.openSettings", () =>
      commands.executeCommand("workbench.action.openSettings", "drafteine")
    )
  );
  // --- language server (bundled alongside the extension) ---------------
  const serverModule = context.asAbsolutePath(path.join("dist", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "drafteine" }],
  };
  client = new LanguageClient(
    "drafteine",
    "Drafteine Language Server",
    serverOptions,
    clientOptions
  );
  void client.start();

  // --- live preview ----------------------------------------------------
  context.subscriptions.push(
    commands.registerCommand("drafteine.showPreview", () => {
      const doc = window.activeTextEditor?.document;
      if (!doc || doc.languageId !== "drafteine") return;
      if (!panel) {
        panel = window.createWebviewPanel(
          "drafteinePreview",
          `Preview ${path.basename(doc.fileName)}`,
          ViewColumn.Beside,
          {}
        );
        panel.onDidDispose(() => (panel = undefined));
      }
      panel.title = `Preview ${path.basename(doc.fileName)}`;
      panel.webview.html = renderPreview(doc.getText());
    }),
    workspace.onDidChangeTextDocument((e) => {
      if (panel && e.document.languageId === "drafteine") {
        panel.webview.html = renderPreview(e.document.getText());
      }
    }),
    window.onDidChangeActiveTextEditor((editor) => {
      if (panel && editor?.document.languageId === "drafteine") {
        panel.title = `Preview ${path.basename(editor.document.fileName)}`;
        panel.webview.html = renderPreview(editor.document.getText());
      }
    })
  );

  // --- materialize into the workspace ----------------------------------
  context.subscriptions.push(
    commands.registerCommand("drafteine.applyDraft", () => applyDraft())
  );

  // --- structure view: dim annotations so the tree silhouette dominates -
  const dimmed = window.createTextEditorDecorationType({ opacity: "0.35" });
  let structureView = false;

  const refreshDim = (): void => {
    for (const editor of window.visibleTextEditors) {
      if (editor.document.languageId !== "drafteine") continue;
      if (!structureView) {
        editor.setDecorations(dimmed, []);
        continue;
      }
      const doc = editor.document;
      const result = parse(doc.getText());
      const ranges: Range[] = [];
      for (const line of result.lines) {
        if (line.kind === "annotation" || line.kind === "block-end" || line.kind === "pragma") {
          ranges.push(doc.lineAt(line.lineNo).range);
          continue;
        }
        for (const a of line.annotations) {
          if (a.fromProfile) continue;
          ranges.push(new Range(doc.positionAt(a.from), doc.positionAt(a.to)));
        }
      }
      editor.setDecorations(dimmed, ranges);
    }
  };

  context.subscriptions.push(
    dimmed,
    commands.registerCommand("drafteine.toggleStructureView", () => {
      structureView = !structureView;
      refreshDim();
    }),
    workspace.onDidChangeTextDocument((e) => {
      if (structureView && e.document.languageId === "drafteine") refreshDim();
    }),
    window.onDidChangeVisibleTextEditors(() => {
      if (structureView) refreshDim();
    })
  );

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("drafteine.preview")) return;
      const doc = window.activeTextEditor?.document;
      if (panel && doc?.languageId === "drafteine") {
        panel.webview.html = renderPreview(doc.getText());
      }
    })
  );

  return { extendMarkdownIt };
}

async function applyDraft(): Promise<void> {
  const doc = window.activeTextEditor?.document;
  if (!doc || doc.languageId !== "drafteine") return;
  const root = workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    void window.showErrorMessage("Drafteine: open a workspace folder to apply into.");
    return;
  }
  const result = parse(doc.getText());
  if (result.stats.errors > 0) {
    void window.showErrorMessage(
      `Drafteine: draft has ${result.stats.errors} error(s). Fix them before applying.`
    );
    return;
  }

  const rootDir = root.fsPath;
  let templatesDir: string | null = null;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(rootDir, "drafteine.config.json"), "utf8")
    ) as { templates?: unknown };
    if (typeof cfg.templates === "string") {
      templatesDir = path.resolve(rootDir, cfg.templates);
    }
  } catch {
    // no config or unreadable config means no templates
  }

  const io: ApplyIO = {
    kind(p) {
      const abs = path.resolve(rootDir, p);
      if (!abs.startsWith(rootDir)) return "file"; // outside root: pretend it exists, never touch
      if (!fs.existsSync(abs)) return "missing";
      return fs.statSync(abs).isDirectory() ? "dir" : "file";
    },
    mkdir: (p) => fs.mkdirSync(path.resolve(rootDir, p), { recursive: true }),
    write(p, content) {
      const abs = path.resolve(rootDir, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (content === null) fs.closeSync(fs.openSync(abs, "a"));
      else fs.writeFileSync(abs, content, { flag: "wx" });
    },
    template(name) {
      if (
        templatesDir === null ||
        name === "" ||
        path.isAbsolute(name) ||
        name.split(/[\\/]/).includes("..")
      ) {
        return null;
      }
      try {
        const joined = path.join(templatesDir, name);
        if (fs.lstatSync(joined).isSymbolicLink()) return null;
        const real = fs.realpathSync(joined);
        const realDir = fs.realpathSync(templatesDir);
        if (real !== realDir && !real.startsWith(realDir + path.sep)) return null;
        if (!fs.statSync(real).isFile()) return null;
        return fs.readFileSync(real);
      } catch {
        return null;
      }
    },
  };

  const preview = runApply(result.root, io, { dryRun: true });
  if (preview.errors.length > 0) {
    void window.showErrorMessage(`Drafteine: ${preview.errors.join(" · ")}`);
    return;
  }
  const toCreate = preview.results.filter((r) => r.outcome === "created").length;
  if (toCreate === 0) {
    void window.showInformationMessage("Drafteine: everything already exists.");
    return;
  }

  const choice = await window.showInformationMessage(
    `Create ${toCreate} entr${toCreate === 1 ? "y" : "ies"} in ${path.basename(rootDir)}? Existing files are never touched.`,
    { modal: true },
    "Apply"
  );
  if (choice !== "Apply") return;

  const outcome = runApply(result.root, io);
  const created = outcome.results.filter((r) => r.outcome === "created").length;
  void window.showInformationMessage(
    `Drafteine: created ${created}, skipped ${outcome.results.length - created} existing.`
  );
}

/* ---------------- preview rendering ----------------------------------- */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const FOLDER_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.6 1.8H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 13.8H3a1.5 1.5 0 0 1-1.5-1.5v-8.8z"/></svg>`;
const FILE_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.3L12.5 5v9A1.5 1.5 0 0 1 11 15.5H4A1.5 1.5 0 0 1 2.5 14V3A1.5 1.5 0 0 1 4 1.5z"/><path class="fold" d="M9 1.5V5h3.5"/></svg>`;
const CHEVRON_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const WARN_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15 13.7H1L8 1.8z"/><rect class="mark" x="7.3" y="6" width="1.4" height="4"/><rect class="mark" x="7.3" y="11" width="1.4" height="1.4"/></svg>`;

/** Rows plus status line, shared by the webview and markdown fences. */

let fileColorsCss = "";

function previewTheme(): string {
  const t = workspace.getConfiguration("drafteine").get<string>("preview.theme", "colored");
  if (t === "manila") return "colored"; // earlier name for the same idea
  return ["colored", "minimal", "espresso"].includes(t) ? t : "colored";
}

function rowHtml(line: Line, isBranch: boolean): string {
  const hasError = line.errors.some((e) => e.severity === "error");
  const guides = `<span class="guide"></span>`.repeat(line.depth);
  const icon = hasError ? WARN_SVG : line.isFolder ? FOLDER_SVG : FILE_SVG;
  let iconClass = hasError ? "warn" : line.isFolder ? "folder" : "file";
  if (iconClass === "file") {
    const dot = line.name.lastIndexOf(".");
    if (dot > 0) {
      const ext = line.name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (ext) iconClass += " dfx-" + ext;
    }
  }
  const caret = `<span class="caret">${isBranch ? CHEVRON_SVG : ""}</span>`;
  const chips = line.annotations
    .filter((a) => !a.fromProfile)
    .map((a) => `<span class="chip">${esc(a.key)}${a.value !== null ? `: ${esc(a.value)}` : ""}</span>`)
    .join("");
  const note = hasError ? `<span class="err">${esc(line.errors[0].message)}</span>` : "";
  return (
    `<div class="row${hasError ? " bad" : ""}">${guides}${caret}` +
    `<span class="icon ${iconClass}">${icon}</span>` +
    `<span class="name">${esc(line.name || "(unnamed)")}</span>${chips}${note}</div>`
  );
}

function renderRowsHtml(text: string): string {
  const result: ParseResult = parse(text);
  const walk = (node: TreeNode): string => {
    const line = node.line!;
    if (!node.isFolder || node.children.length === 0) {
      return rowHtml(line, false);
    }
    return (
      `<details open><summary>${rowHtml(line, true)}</summary>` +
      node.children.map(walk).join("\n") +
      `</details>`
    );
  };
  const rows = result.root.children.map(walk).join("\n");
  const { folders, files, errors } = result.stats;
  const status = `${folders} folders · ${files} files · ${errors === 0 ? "draft is clean" : `${errors} errors`}`;
  return (
    (rows || `<p class="empty">Nothing drafted yet. Type a name, end folders with /.</p>`) +
    `<div class="status">${status}</div>`
  );
}

/* ---------------- markdown fence rendering ----------------------------- */

interface MarkdownItLike {
  renderer: { rules: { fence?: (...args: unknown[]) => string } };
  utils: { escapeHtml(str: string): string };
}

/** Renders \`\`\`drafteine fences as trees in the built-in markdown preview. */
export function extendMarkdownIt(md: MarkdownItLike): MarkdownItLike {
  const previous = md.renderer.rules.fence;
  md.renderer.rules.fence = (...args: unknown[]): string => {
    const tokens = args[0] as Array<{ info: string; content: string }>;
    const idx = args[1] as number;
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0];
    if (lang === "drafteine" || lang === "dft") {
      return `<div class="drafteine-fence theme-${previewTheme()}">${renderRowsHtml(token.content)}</div>\n`;
    }
    return previous
      ? previous(...args)
      : `<pre>${md.utils.escapeHtml(token.content)}</pre>`;
  };
  return md;
}

function renderPreview(text: string): string {
  return `<!DOCTYPE html><html><head><style>
    body { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
           color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0.8rem 1rem; }
    .row { display: flex; align-items: baseline; gap: 0.45rem; padding: 0.14rem 0.3rem; border-radius: 4px; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .guide { width: 1rem; flex: none; border-left: 1px solid var(--vscode-tree-indentGuidesStroke, #444); margin-left: 0.45rem; align-self: stretch; }
    summary { list-style: none; cursor: pointer; }
    summary::-webkit-details-marker { display: none; }
    .caret { flex: none; width: 0.9rem; align-self: center; display: flex; align-items: center; opacity: 0.55; transition: transform 0.12s; }
    .caret svg { width: 10px; height: 10px; }
    details[open] > summary .caret { transform: rotate(90deg); }
    .icon { align-self: center; }
    .icon { flex: none; width: 1rem; display: flex; align-items: center; }
    .icon svg { width: 14px; height: 14px; }
    .icon.folder svg path { fill: var(--vscode-symbolIcon-folderForeground, #8fb4d4); }
    .icon.file svg path { fill: none; stroke: var(--vscode-symbolIcon-fileForeground, #8fb4d4); stroke-width: 1; }
    .theme-colored .icon.folder svg path { fill: #e2c088; } /* manila */
    .theme-espresso .icon.folder svg path { fill: #e8a33d; }
    .theme-espresso .icon.file svg path { stroke: #8fb4d4; }
    ${fileColorsCss}
    .icon.file svg .fold { fill: none; stroke-width: 1.1; }
    .icon.warn svg path { fill: var(--vscode-errorForeground); }
    .icon.warn svg .mark { fill: var(--vscode-editor-background, #1e1e1e); }
    .err { color: var(--vscode-errorForeground); }
    .bad .name { text-decoration: line-through; opacity: 0.6; }
    .chip { font-size: 0.78em; font-style: italic; opacity: 0.75;
            border: 1px solid var(--vscode-widget-border, #555); border-radius: 999px; padding: 0 0.5em; }
    .err { font-size: 0.85em; }
    .status { margin-top: 0.8rem; padding-top: 0.5rem; border-top: 1px solid var(--vscode-widget-border, #444);
              font-size: 0.85em; opacity: 0.8; }
    .empty { opacity: 0.6; }
  </style></head><body><div class="theme-${previewTheme()}">
    ${renderRowsHtml(text)}
  </div></body></html>`;
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
