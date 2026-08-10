/**
 * Check: verify that reality conforms to a parsed draft.
 */
import type { CheckIO, TreeNode, Violation } from "./types.js";

/**
 * Verify that reality (as seen through `io`) conforms to a parsed draft.
 * Semantics: drafted entries must exist, missing ones are violations, and
 * extras are fine. A trailing `?` (or the `optional` flag) exempts absence
 * but a present entry must still conform. `strict` makes a folder's
 * undeclared direct children violations. `max-lines: n` bounds a file.
 * Error lines never reach enforcement.
 */
export function runCheck(root: TreeNode, io: CheckIO): Violation[] {
  const violations: Violation[] = [];
  walk(root, "");
  return violations;

  function has(node: TreeNode, key: string): boolean {
    return node.annotations.some((a) => a.key === key);
  }
  function value(node: TreeNode, key: string): string | null | undefined {
    const a = node.annotations.find((x) => x.key === key);
    return a ? a.value : undefined;
  }
  /** Own annotation first, then the nearest annotated ancestor folder.
   *  Metric annotations on a folder act as recursive defaults. */
  function inherited(node: TreeNode, key: string): string | null | undefined {
    for (let n: TreeNode | undefined = node; n && n.kind !== "root"; n = n.parent) {
      const v = value(n, key);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  /** Parse a size value like 200, 64k, or 2m into bytes (1000 based). */
  function parseSize(v: string): number | null {
    const m = /^(\d+(?:\.\d+)?)\s*([km]?)b?$/i.exec(v);
    if (!m) return null;
    const mult = { "": 1, k: 1000, m: 1000000 }[m[2].toLowerCase() as "" | "k" | "m"];
    return Math.round(Number(m[1]) * mult);
  }
  /** allow glob: * and ? on immediate child names, trailing / = dirs only. */
  function allowMatcher(pat: string): (name: string, isDir: boolean) => boolean {
    const dirOnly = pat.endsWith("/");
    const core = dirOnly ? pat.slice(0, -1) : pat;
    const rx = new RegExp(
      "^" +
        core
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]") +
        "$"
    );
    return (name, isDir) => (!dirOnly || isDir) && rx.test(name);
  }
  /** Metric checks for one file path, resolving defaults from `anchor`. */
  function checkFileMetrics(anchor: TreeNode, p: string): void {
    const maxLines = inherited(anchor, "max-lines");
    if (maxLines !== undefined && maxLines !== null) {
      const n = Number(maxLines);
      if (!Number.isFinite(n) || n <= 0) {
        violations.push({
          path: p,
          kind: "bad-annotation",
          message: `${p}: max-lines: ${maxLines} is not a positive number`,
          node: anchor,
        });
      } else {
        const count = io.countLines(p);
        if (count > n) {
          violations.push({
            path: p,
            kind: "max-lines",
            message: `${p}: ${count} lines, exceeds max-lines: ${n}`,
            node: anchor,
          });
        }
      }
    }
    const maxSize = inherited(anchor, "max-size");
    if (maxSize !== undefined && maxSize !== null) {
      const limit = parseSize(maxSize);
      if (limit === null || limit <= 0) {
        violations.push({
          path: p,
          kind: "bad-annotation",
          message: `${p}: max-size: ${maxSize} is not a size like 200, 64k, or 2m`,
          node: anchor,
        });
      } else {
        const size = io.fileSize(p);
        if (size > limit) {
          violations.push({
            path: p,
            kind: "max-size",
            message: `${p}: ${size} bytes, exceeds max-size: ${maxSize}`,
            node: anchor,
          });
        }
      }
    }
  }

  function walk(node: TreeNode, prefix: string): void {
    for (const child of node.children) {
      if (child.line!.errors.some((e) => e.severity === "error")) continue;
      const p = prefix + child.name;

      if (has(child, "forbidden")) {
        if (io.kind(p) !== "missing") {
          violations.push({
            path: p,
            kind: "forbidden",
            message: `${p}: exists but is declared forbidden`,
            node: child,
          });
        }
        continue;
      }

      const kind = io.kind(p);

      if (kind === "missing") {
        if (!has(child, "optional")) {
          violations.push({
            path: p,
            kind: "missing",
            message: `${p}: drafted but missing from disk`,
            node: child,
          });
        }
        continue;
      }
      if (child.isFolder && kind !== "dir") {
        violations.push({
          path: p,
          kind: "type-mismatch",
          message: `${p}: expected a folder, found a file`,
          node: child,
        });
        continue;
      }
      if (!child.isFolder && kind === "dir") {
        violations.push({
          path: p,
          kind: "type-mismatch",
          message: `${p}: expected a file, found a folder`,
          node: child,
        });
        continue;
      }

      if (!child.isFolder) {
        checkFileMetrics(child, p);
        continue;
      }

      const countMax = value(child, "count");
      if (countMax !== undefined && countMax !== null) {
        const n = Number(countMax);
        if (!Number.isFinite(n) || n <= 0) {
          violations.push({
            path: p,
            kind: "bad-annotation",
            message: `${p}: count: ${countMax} is not a positive number`,
            node: child,
          });
        } else {
          const total = io.readdir(p).length;
          if (total > n) {
            violations.push({
              path: p,
              kind: "count",
              message: `${p}: ${total} direct entries, exceeds count: ${n}`,
              node: child,
            });
          }
        }
      }

      if (has(child, "strict")) {
        const declared = new Set(child.children.map((x) => x.name));
        const allow = child.annotations.find((a) => a.key === "allow");
        const matchers = (allow?.values ?? []).map(allowMatcher);
        for (const entry of io.readdir(p)) {
          if (declared.has(entry)) continue;
          const entryPath = `${p}/${entry}`;
          const isDir = io.kind(entryPath) === "dir";
          if (matchers.some((m) => m(entry, isDir))) {
            // Tolerated extras still honor the folder's metric defaults.
            if (!isDir) checkFileMetrics(child, entryPath);
            continue;
          }
          violations.push({
            path: entryPath,
            kind: "strict-extra",
            message: `${entryPath}: undeclared direct child of strict folder ${p}/`,
            node: child,
            entryKind: isDir ? "dir" : "file",
          });
        }
      }
      walk(child, p + "/");
    }
  }
}
