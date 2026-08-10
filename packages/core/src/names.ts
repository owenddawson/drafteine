/**
 * Name rules and quoting: which characters names may hold, when a name
 * needs quotes to round-trip through the grammar, and the canonical
 * quoted forms the formatter and generators emit.
 */
import { PRAGMA_TRIGGER_RE } from "./pragma.js";

export const FORBIDDEN_NAME_CHARS = /[\\:*?"<>|]/;
/** Bare name runs until whitespace followed by `@`, `#`, or `{`, or end of line. */
export const NAME_BOUNDARY_RE = /^(.*?)\s+(?=[@#{])/;
/** Quoted name: "..." with \" and \\ escapes. */
export const QUOTED_NAME_RE = /^"((?:[^"\\]|\\.)*)"/;

export const unescape = (s: string): string => s.replace(/\\(.)/g, "$1");

/** True when `name` needs quotes to round-trip through the grammar. A name
 *  shaped like the version pragma quotes too, or a first-line file named
 *  “drafteine 1” would reparse as a pragma. */
export function needsQuoting(name: string): boolean {
  return name === "" || /^[#"\s]|\s$| @| #|\/$/.test(name) || PRAGMA_TRIGGER_RE.test(name);
}

/** Render a name in canonical source form (quoted only when necessary). */
export function quoteName(name: string): string {
  return needsQuoting(name)
    ? `"${name.replace(/[\\"]/g, (ch) => "\\" + ch)}"`
    : name;
}

export function quoteValue(v: string): string {
  return /[)",\\]|^\s|\s$/.test(v)
    ? `"${v.replace(/[\\"]/g, (ch) => "\\" + ch)}"`
    : v;
}
