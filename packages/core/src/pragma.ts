/**
 * The version pragma: a plain first content line, `drafteine 1`, declaring
 * the format a draft is written in. Always optional. An absent pragma means
 * format 1, permanently, so unversioned drafts never change meaning when
 * the format grows. Reading a newer format warns and continues best-effort.
 * Verbs that rewrite the draft or materialize from it refuse instead (the
 * no-rewrite rule in SPEC.md): best-effort reading is graceful degradation,
 * best-effort rewriting is corruption.
 */
import { SPEC_VERSION, type Diagnostic, type Line } from "./types.js";

/** Any first content line shaped like `drafteine <digit>…` is claimed as a
 *  pragma attempt, so a typo diagnoses instead of silently becoming a file.
 *  Wordier names (`drafteine notes.txt`) stay ordinary files. */
export const PRAGMA_TRIGGER_RE = /^drafteine[ \t]+[0-9]/;
/** The only valid version form: a whole number, no leading zeros. */
const VERSION_RE = /^[1-9][0-9]{0,8}$/;

/**
 * Scan a potential pragma. The caller guarantees this is the first content
 * line of the document and unindented. Returns true when the line was
 * consumed as a pragma, valid or malformed. False hands it back to entry
 * parsing. `pos` is the index in `raw` where content starts.
 */
export function scanPragma(
  line: Line,
  raw: string,
  pos: number,
  diagnostics: Diagnostic[]
): boolean {
  let start = pos;
  if (raw.charCodeAt(start) === 0xfeff) start++; // tolerate a UTF-8 BOM on line one
  if (!PRAGMA_TRIGGER_RE.test(raw.slice(start))) return false;

  line.kind = "pragma";
  const report = (from: number, to: number, severity: "error" | "warning", message: string): void => {
    const d: Diagnostic = { from, to, severity, message };
    line.errors.push(d);
    diagnostics.push(d);
  };

  let cursor = start + "drafteine".length;
  while (raw[cursor] === " " || raw[cursor] === "\t") cursor++;
  let end = cursor;
  while (end < raw.length && raw[end] !== " " && raw[end] !== "\t") end++;
  const token = raw.slice(cursor, end).trimEnd(); // trailing \r on CRLF input

  if (!VERSION_RE.test(token)) {
    report(
      line.from + cursor,
      line.from + cursor + Math.max(token.length, 1),
      "error",
      `Malformed version pragma. Expected “drafteine <number>”, a whole number with no leading zeros.`
    );
    return true;
  }
  const version = Number(token);
  line.version = version;
  line.spans.version = [line.from + cursor, line.from + cursor + token.length];

  // After the version: nothing, or a trailing comment. Text after a newer
  // version is tolerated, it may be meaningful in that format, and the
  // newer-format warning below already covers the line.
  let after = end;
  while (raw[after] === " " || raw[after] === "\t") after++;
  const remainder = raw.slice(after).trimEnd();
  if (remainder.startsWith("#")) {
    line.spans.comment = [line.from + after, line.to];
  } else if (remainder !== "" && version <= SPEC_VERSION) {
    report(
      line.from + after,
      line.to,
      "error",
      "Unexpected text after the version pragma. Only a # comment may follow the number."
    );
  }

  if (version > SPEC_VERSION) {
    report(
      line.from + start,
      line.from + cursor + token.length,
      "warning",
      `Draft declares Drafteine format ${version}, but this tool implements format ${SPEC_VERSION}. Reading best-effort. Rewriting verbs will refuse.`
    );
  }
  return true;
}
