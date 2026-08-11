/**
 * Check: verify that reality conforms to a parsed draft.
 */
import type { CheckIO, TreeNode, Violation } from "./types.js";
import { globMatcher } from "./names.js";

interface Ban {
  pattern: string;
  origin: string;
  match: (name: string, isDir: boolean) => boolean;
}

/**
 * Verify that reality (as seen through `io`) conforms to a parsed draft.
 * Semantics: drafted entries must exist, missing ones are violations, and
 * extras are fine. A trailing `?` (or the `optional` flag) exempts absence
 * but a present entry must still conform. `strict` makes a folder's
 * undeclared direct children violations. `max-lines: n` bounds a file.
 * `ban: [patterns]` on a folder bans matching basenames through its whole
 * real subtree, accumulates downward, and beats declarations.
 * Error lines never reach enforcement.
 */
export function runCheck(root: TreeNode, io: CheckIO): Violation[] {
  const violations: Violation[] = [];
  walk(root, "", []);
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
  /** Validated ban patterns declared on this folder, as matchers. */
  function bansOf(node: TreeNode, p: string): Ban[] {
    const attr = node.annotations.find((a) => a.key === "ban");
    if (!attr) return [];
    const out: Ban[] = [];
    for (const pattern of attr.values) {
      const core = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
      if (core === "" || core === "." || core === ".." || core.includes("/") || pattern.includes("**")) {
        violations.push({
          path: p,
          kind: "bad-annotation",
          message: `${p}: ban pattern “${pattern}” is not a single-name glob`,
          node,
        });
        continue;
      }
      out.push({ pattern, origin: p, match: globMatcher(pattern) });
    }
    return out;
  }

  /** Scan the real subtree under `p` for entries matching this folder's
   *  own bans. Symlinks are never followed, and a trailing-slash pattern
   *  never matches a symlinked directory. An unreadable directory fails
   *  the check rather than passing it. */
  function scanBans(node: TreeNode, p: string, bans: Ban[]): void {
    let entries: Array<{ name: string; kind: "file" | "dir" | "link" }>;
    try {
      entries = io.entries
        ? io.entries(p)
        : io.readdir(p).map((name) => ({
            name,
            kind: io.kind(`${p}/${name}`) === "dir" ? ("dir" as const) : ("file" as const),
          }));
    } catch {
      violations.push({
        path: p,
        kind: "banned",
        message: `${p}: unreadable while enforcing ban, check incomplete`,
        node,
      });
      return;
    }
    for (const e of entries) {
      const entryPath = `${p}/${e.name}`;
      const isDir = e.kind === "dir";
      const hit = bans.find((b) => b.match(e.name, isDir));
      if (hit) {
        violations.push({
          path: entryPath,
          kind: "banned",
          message: `${entryPath}: matches ban: ${hit.pattern} (from ${hit.origin}/)`,
          node,
        });
        continue; // reporting the banned entry itself is enough
      }
      if (isDir) scanBans(node, entryPath, bans);
    }
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

  function walk(node: TreeNode, prefix: string, bans: Ban[]): void {
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

      // Bans beat declarations. A required entry matching an inherited
      // ban makes the draft unsatisfiable; an optional one may only be
      // absent.
      const banHit = bans.find((b) => b.match(child.name, child.isFolder));
      if (banHit) {
        if (!has(child, "optional")) {
          violations.push({
            path: p,
            kind: "banned",
            message: `${p}: required entry matches ban: ${banHit.pattern} (from ${banHit.origin}/), the draft cannot be satisfied`,
            node: child,
          });
        } else if (io.kind(p) !== "missing") {
          violations.push({
            path: p,
            kind: "banned",
            message: `${p}: optional entry is present but matches ban: ${banHit.pattern} (from ${banHit.origin}/)`,
            node: child,
          });
        }
        continue;
      }

      const ownBans = child.isFolder ? bansOf(child, p) : [];
      const kind = io.kind(p);
      if (ownBans.length > 0 && kind === "dir") scanBans(child, p, ownBans);

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

      const childBans = bans.concat(ownBans);
      if (has(child, "strict")) {
        const declared = new Set(child.children.map((x) => x.name));
        const allow = child.annotations.find((a) => a.key === "allow");
        // A strict folder tolerating everything is a contradiction, and
        // the classic silent bypass. Loosening must be legible: remove
        // strict instead of neutering it.
        for (const pattern of allow?.values ?? []) {
          if (pattern === "*" || pattern === "**") {
            violations.push({
              path: p,
              kind: "bad-annotation",
              message: `${p}: allow: ${pattern} tolerates everything and makes strict meaningless. Remove strict instead.`,
              node: child,
            });
          }
        }
        const matchers = (allow?.values ?? []).map(globMatcher);
        for (const entry of io.readdir(p)) {
          if (declared.has(entry)) continue;
          const entryPath = `${p}/${entry}`;
          const isDir = io.kind(entryPath) === "dir";
          // Banned extras are already reported by the ban scan.
          if (childBans.some((b) => b.match(entry, isDir))) continue;
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
      walk(child, p + "/", childBans);
    }
  }
}
