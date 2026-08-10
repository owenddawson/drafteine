/**
 * Filesystem aware name completion. When the cursor sits in the name
 * position of an entry line, the server offers the real entries of the
 * directory that position resolves to. Completion is assistive only. A
 * draft may legitimately declare paths that do not exist yet, so nothing
 * here validates existence or reports problems.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CompletionItemKind, type CompletionItem } from "vscode-languageserver/node.js";
import type { ParseResult, TreeNode } from "@drafteine/core";

/** Directory this draft governs. A contracts entry in drafteine.config.json
 *  whose draft path matches the document wins. The fallback is the draft
 *  file's own directory. */
function draftRoot(docPath: string, workspaceRoots: string[]): string {
  for (const ws of workspaceRoots) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(ws, "drafteine.config.json"), "utf8")
      ) as { contracts?: unknown };
      if (!Array.isArray(raw.contracts)) continue;
      for (const entry of raw.contracts) {
        const draft = typeof entry === "string" ? entry : (entry as { draft?: string }).draft;
        const root = typeof entry === "string" ? "." : ((entry as { root?: string }).root ?? ".");
        if (draft && path.resolve(ws, draft) === docPath) return path.resolve(ws, root);
      }
    } catch {
      // A missing or malformed config falls through to the next root.
    }
  }
  return path.dirname(docPath);
}

/** Segments declared by the ancestor chain above this line: the nearest
 *  shallower folder lines, outermost first. Null when the chain passes
 *  through a file, which nothing can nest under. */
function ancestorSegments(result: ParseResult, lineNo: number, depth: number): string[] | null {
  const segments: string[] = [];
  let want = depth - 1;
  for (let i = lineNo - 1; i >= 0 && want >= 0; i--) {
    const l = result.lines[i];
    if (!l || (l.kind !== "folder" && l.kind !== "file") || l.depth > want) continue;
    if (!l.isFolder) return null;
    segments.unshift(...(l.path ?? [l.name]));
    want = l.depth - 1;
  }
  return segments;
}

/** Names already declared as children of the folder at these segments,
 *  minus whatever the current line itself declares. */
function declaredSiblings(result: ParseResult, segments: string[], lineNo: number): Set<string> {
  let node: TreeNode | undefined = result.root;
  for (const seg of segments) {
    node = node?.children.find((c) => c.isFolder && c.name === seg);
  }
  const out = new Set<string>();
  for (const child of node?.children ?? []) {
    if (child.line?.lineNo !== lineNo) out.add(child.name);
  }
  return out;
}

/** Completions for the name position of an entry line: the real entries
 *  of the resolved directory, folders completing with a trailing slash.
 *  Empty when the position is not a name or the directory is unreadable. */
export function nameCompletions(
  docUri: string,
  before: string,
  result: ParseResult,
  lineNo: number,
  workspaceRoots: string[]
): CompletionItem[] {
  const line = result.lines[lineNo];
  if (line && line.kind !== "folder" && line.kind !== "file" && line.kind !== "blank") return [];
  const stripped = before.replace(/^[ \t]*/, "");
  // Name position only: never inside a container, after one, or in a comment.
  if (/[{}#]/.test(stripped)) return [];
  let docPath: string;
  try {
    docPath = fileURLToPath(docUri);
  } catch {
    return [];
  }
  const depth =
    line && line.kind !== "blank"
      ? line.depth
      : Math.floor((before.length - stripped.length) / result.indentUnit);
  const ancestors = ancestorSegments(result, lineNo, depth);
  if (ancestors === null) return [];
  // On a path line the segments typed before the last slash narrow the target.
  const lastSlash = stripped.lastIndexOf("/");
  const typed = lastSlash >= 0 ? stripped.slice(0, lastSlash).split("/").filter(Boolean) : [];
  const segments = [...ancestors, ...typed];
  const declared = declaredSiblings(result, segments, lineNo);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(draftRoot(docPath, workspaceRoots), ...segments), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  const items: CompletionItem[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (declared.has(entry.name)) continue;
    items.push(
      entry.isDirectory()
        ? {
            label: entry.name + "/",
            kind: CompletionItemKind.Folder,
            filterText: entry.name,
            sortText: "0" + entry.name,
          }
        : { label: entry.name, kind: CompletionItemKind.File, sortText: "1" + entry.name }
    );
  }
  return items;
}
