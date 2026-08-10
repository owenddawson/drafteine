/**
 * Accept: reconcile a draft's membership with reality, the snapshot-update
 * model for structure enforcement. Declares strict-folder extras and
 * removes drafted-but-missing entries. Policy violations (metrics,
 * forbidden, count) and type mismatches are never auto-amended: those
 * stay human decisions, listed as remaining.
 */
import { quoteName } from "./parser.js";
import type { ParseResult, TreeNode, Violation } from "./types.js";

export interface AcceptResult {
  /** The amended draft text. */
  text: string;
  /** Paths newly declared in the draft. */
  declared: string[];
  /** Paths removed from the draft. */
  removed: string[];
  /** Violations accept refuses to auto-amend. */
  remaining: Violation[];
}

/** Last line number of an entry and everything belonging to it: its block
 *  lines and its structural subtree. */
function entrySpanEnd(result: ParseResult, node: TreeNode): number {
  const start = node.line!.lineNo;
  const depth = node.line!.depth;
  let end = start;
  for (let i = start + 1; i < result.lines.length; i++) {
    const l = result.lines[i];
    if (l.kind === "annotation" || l.kind === "block-end") {
      end = i;
      continue;
    }
    if (l.kind === "folder" || l.kind === "file") {
      if (l.depth <= depth) break;
      end = i;
    }
  }
  return end;
}

export function acceptViolations(
  source: string,
  result: ParseResult,
  violations: Violation[],
  options: { prune?: boolean } = {}
): AcceptResult {
  const lines = source.split("\n");
  const declared: string[] = [];
  const removed: string[] = [];
  const remaining: Violation[] = [];

  interface Insertion {
    afterLine: number;
    text: string;
    path: string;
  }
  const insertions: Insertion[] = [];
  const removals: Array<{ from: number; to: number; path: string }> = [];

  for (const v of violations) {
    if (v.kind === "strict-extra") {
      const folder = v.node;
      const name = v.path.slice(v.path.lastIndexOf("/") + 1);
      const indent = " ".repeat((folder.depth + 1) * result.indentUnit);
      const last = folder.children.length
        ? entrySpanEnd(result, folder.children[folder.children.length - 1])
        : entrySpanEnd(result, folder); // folder line itself, past any block
      insertions.push({
        afterLine: last,
        text: indent + quoteName(name) + (v.entryKind === "dir" ? "/" : ""),
        path: v.path + (v.entryKind === "dir" ? "/" : ""),
      });
    } else if (v.kind === "missing" && options.prune) {
      removals.push({
        from: v.node.line!.lineNo,
        to: entrySpanEnd(result, v.node),
        path: v.path,
      });
    } else {
      remaining.push(v);
    }
  }

  // Apply from the bottom up so earlier line numbers stay valid.
  const edits = [
    ...insertions.map((i) => ({ at: i.afterLine, insertion: i, removal: null as null })),
    ...removals.map((r) => ({ at: r.from, insertion: null as null, removal: r })),
  ].sort((a, b) => b.at - a.at || (a.insertion ? -1 : 1));

  for (const edit of edits) {
    if (edit.insertion) {
      lines.splice(edit.insertion.afterLine + 1, 0, edit.insertion.text);
      declared.push(edit.insertion.path);
    } else if (edit.removal) {
      lines.splice(edit.removal.from, edit.removal.to - edit.removal.from + 1);
      removed.push(edit.removal.path);
    }
  }

  return { text: lines.join("\n"), declared: declared.reverse(), removed: removed.reverse(), remaining };
}
