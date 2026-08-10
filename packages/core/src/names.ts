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

/** Why a name or path segment is invalid, or null when it is fine. */
export function nameComplaint(segment: string, isFolder: boolean): string | null {
  if (segment === "") {
    return isFolder ? "Folder has no name." : "Expected a file or folder name.";
  }
  if (segment === "." || segment === "..") {
    return `“${segment}” is not a valid name. It refers to a directory position, not an entry.`;
  }
  if (FORBIDDEN_NAME_CHARS.test(segment)) {
    return `Name contains a character not allowed in paths: ${segment.match(FORBIDDEN_NAME_CHARS)![0]}`;
  }
  return null;
}

/** True when `name` needs quotes to round-trip through the grammar: bare
 *  collisions (` #`, ` {`, ` @`, edge whitespace, interior `/` reads as a
 *  path), plus names shaped like the pragma or a preset definition, which
 *  the keyword lines would otherwise claim. */
export function needsQuoting(name: string): boolean {
  return (
    name === "" ||
    /^[#"\s]|\s$| @| #| \{|\//.test(name) ||
    PRAGMA_TRIGGER_RE.test(name) ||
    /^preset[ \t]/.test(name)
  );
}

/** Render a name in canonical source form (quoted only when necessary). */
export function quoteName(name: string): string {
  return needsQuoting(name)
    ? `"${name.replace(/[\\"]/g, (ch) => "\\" + ch)}"`
    : name;
}

export function quoteValue(v: string): string {
  return /[",#\\\[\]{}]|^\s|\s$/.test(v)
    ? `"${v.replace(/[\\"]/g, (ch) => "\\" + ch)}"`
    : v;
}
