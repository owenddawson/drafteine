/**
 * Snapshot: walk a real directory into draft lines. Folders first, each
 * group in codepoint order, deterministic across locales. Symlinked
 * directories report as files, so walks never loop.
 */
import fs from "node:fs";
import path from "node:path";
import { quoteName } from "@drafteine/core";

export const SNAPSHOT_IGNORE = new Set([".git", "node_modules"]);

/** Names no draft can express even quoted: forbidden portability chars,
 *  control chars, and the dot names. Everything else quotes cleanly. */
const UNREPRESENTABLE_NAME = /[\\:*?"<>|\x00-\x1f]|^\.{1,2}$/;

export interface SnapshotOptions {
  all: boolean;
  ignore: ((relPath: string, isDir: boolean) => boolean) | null;
}

export function snapshotWalk(
  dir: string,
  depth: number,
  out: string[],
  rel: string,
  opts: SnapshotOptions
): void {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory: skip silently rather than abort the draft
  }
  const visible = entries.filter((e) => opts.all || !SNAPSHOT_IGNORE.has(e.name));
  visible.sort((a, b) =>
    a.isDirectory() === b.isDirectory()
      ? a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      : a.isDirectory() ? -1 : 1
  );
  for (const e of visible) {
    const isDir = e.isDirectory();
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    if (opts.ignore && opts.ignore(childRel, isDir)) continue;
    if (UNREPRESENTABLE_NAME.test(e.name)) {
      out.push(
        "  ".repeat(depth) + `# skipped (unrepresentable name): ${e.name.replace(/[\r\n]/g, " ")}`
      );
      continue;
    }
    out.push("  ".repeat(depth) + quoteName(e.name) + (isDir ? "/" : ""));
    if (isDir) snapshotWalk(path.join(dir, e.name), depth + 1, out, childRel, opts);
  }
}
