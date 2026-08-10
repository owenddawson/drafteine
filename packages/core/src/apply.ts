/**
 * Apply: materialize a parsed draft through injectable IO, so the CLI and
 * the VS Code extension share one implementation of apply semantics.
 *
 * Template preflight is all or nothing: every referenced template is
 * loaded and validated before anything is written. A single failure
 * reports every problem at once and mutates nothing.
 */
import { plan } from "./plan.js";
import type { PlanOp, TreeNode } from "./types.js";

export interface ApplyIO {
  /** What exists at this draft-relative path? */
  kind(path: string): "file" | "dir" | "missing";
  /** Create a directory (parents may be assumed to exist in plan order). */
  mkdir(path: string): void;
  /** Create a file with the given bytes, or empty when null. */
  write(path: string, content: Uint8Array | null): void;
  /**
   * Load a template by name, verbatim bytes. Return null when the name is
   * invalid, escapes the template directory, is not a regular file, is a
   * symlink, or no template directory is configured.
   */
  template(name: string): Uint8Array | null;
}

export interface ApplyOutcome {
  /** Every plan op in order, with what happened to it. */
  results: Array<{ op: PlanOp; outcome: "created" | "exists" }>;
  /** Template problems. Non-empty means nothing was written. */
  errors: string[];
}

export function runApply(
  root: TreeNode,
  io: ApplyIO,
  options: { dryRun?: boolean } = {}
): ApplyOutcome {
  const ops = plan(root);
  const errors: string[] = [];
  const cache = new Map<string, Uint8Array>();

  for (const op of ops) {
    if (op.template === null) continue;
    if (op.type === "mkdir") {
      errors.push(`${op.path}: template is not allowed on folders`);
      continue;
    }
    if (!cache.has(op.template)) {
      const bytes = io.template(op.template);
      if (bytes === null) {
        errors.push(`${op.path}: template "${op.template}" could not be loaded`);
      } else {
        cache.set(op.template, bytes);
      }
    }
  }
  if (errors.length > 0) {
    return { results: [], errors };
  }

  const results: ApplyOutcome["results"] = [];
  for (const op of ops) {
    if (io.kind(op.path) !== "missing") {
      results.push({ op, outcome: "exists" }); // never overwrite anything
      continue;
    }
    if (!options.dryRun) {
      if (op.type === "mkdir") {
        io.mkdir(op.path);
      } else {
        io.write(op.path, op.template !== null ? cache.get(op.template)! : null);
      }
    }
    results.push({ op, outcome: "created" });
  }
  return { results, errors };
}
