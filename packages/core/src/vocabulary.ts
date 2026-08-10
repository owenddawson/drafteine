/**
 * Declared-vocabulary validation: config declares custom annotations with
 * a value shape, check verifies drafts use them accordingly.
 */
import type { ParseResult } from "./types.js";

/** Shape of declared custom annotations: value is "flag", "string", or "number". */
export type VocabularyMap = Record<string, { value?: string }>;

/** Push warnings for declared annotations used with the wrong value shape. */
export function validateVocabulary(result: ParseResult, vocab: VocabularyMap): void {
  if (Object.keys(vocab).length === 0) return;
  for (const line of result.lines) {
    if (line.kind !== "folder" && line.kind !== "file") continue;
    for (const a of line.annotations) {
      if (a.fromProfile) continue;
      const decl = vocab[a.key];
      if (!decl) continue;
      const shape = decl.value ?? "string";
      let message: string | null = null;
      if (shape === "flag" && a.value !== null) {
        message = `“${a.key}” takes no value.`;
      } else if (shape === "number" && (a.value === null || Number.isNaN(Number(a.value)) || a.value.trim() === "")) {
        message = `“${a.key}” requires a numeric value.`;
      } else if (shape === "string" && a.value === null) {
        message = `“${a.key}” requires a value.`;
      }
      if (message) {
        result.diagnostics.push({ from: a.from, to: a.to, severity: "warning", message });
        result.stats.warnings++;
      }
    }
  }
}
