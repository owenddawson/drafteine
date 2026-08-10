/**
 * Shared types for the Drafteine core: parse results, tree nodes,
 * check IO, violations, and profile maps.
 */

export const INDENT_UNIT = 2;

/** The Drafteine format version this library implements. Drafts may declare
 *  theirs with a `drafteine 1` pragma. Absent means 1, permanently. */
export const SPEC_VERSION = 1;

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  from: number;
  to: number;
  severity: Severity;
  message: string;
}

export type LineKind =
  | "blank"
  | "comment"
  | "folder"
  | "file"
  | "annotation"
  | "block-end"
  | "pragma"
  | "preset";

export interface Annotation {
  key: string;
  /** Raw value, items rejoined with a comma and space. Null for flags. */
  value: string | null;
  /** Parsed value items. Empty for flags and for empty parens. */
  values: string[];
  from: number;
  to: number;
  /** Set when this annotation was injected by an attribute profile. */
  fromProfile?: string;
}

export interface Line {
  lineNo: number;
  from: number;
  to: number;
  raw: string;
  kind: LineKind;
  depth: number;
  name: string;
  isFolder: boolean;
  annotations: Annotation[];
  errors: Diagnostic[];
  spans: { name?: [number, number]; comment?: [number, number]; version?: [number, number] };
  node?: TreeNode;
  /** True when this entry line opens an expanded `{ … }` container. */
  opensBlock?: boolean;
  /** Declared format version. Set only on a valid pragma line. */
  version?: number;
  /** For path lines: every segment, leaf included. `name` is the leaf. */
  path?: string[];
  /** For preset definition lines: the preset's name. */
  presetName?: string;
}

export interface TreeNode {
  kind: LineKind | "root";
  name: string;
  depth: number;
  isFolder: boolean;
  annotations: Annotation[];
  children: TreeNode[];
  /** null only on the synthetic root node */
  line: Line | null;
  parent?: TreeNode;
}

export interface Stats {
  folders: number;
  files: number;
  errors: number;
  warnings: number;
}

export interface ParseResult {
  lines: Line[];
  root: TreeNode;
  diagnostics: Diagnostic[];
  stats: Stats;
  /** Spaces per indent level detected in this document (default 2). */
  indentUnit: number;
  /** Format version the draft declares via its pragma. A draft without a
   *  pragma is format 1, permanently, so old drafts never change meaning. */
  version: number;
  /** Presets defined in this draft, already applied to `preset:` refs. */
  presets: ProfileMap;
}

export interface PlanOp {
  type: "mkdir" | "touch";
  path: string;
  template: string | null;
}

/** Filesystem access `runCheck` needs. Injectable so the CLI, the VS Code
 *  extension, and tests share one implementation of check semantics. */
export interface CheckIO {
  /** What exists at this draft-relative path? */
  kind(path: string): "file" | "dir" | "missing";
  /** Entry names inside a directory at this draft-relative path. */
  readdir(path: string): string[];
  /** Line count of the file at this draft-relative path. */
  countLines(path: string): number;
  /** Size in bytes of the file at this draft-relative path. */
  fileSize(path: string): number;
  /** Entries with their on-disk kind, symlinks reported as "link" and
   *  never followed. Optional: ban scanning falls back to readdir+kind. */
  entries?(path: string): Array<{ name: string; kind: "file" | "dir" | "link" }>;
}

export interface Violation {
  /** Draft-relative path the violation is about. */
  path: string;
  message: string;
  kind:
    | "missing"
    | "type-mismatch"
    | "strict-extra"
    | "max-lines"
    | "max-size"
    | "forbidden"
    | "banned"
    | "count"
    | "bad-annotation";
  /** The declaring node. For strict extras this is the strict folder itself. */
  node: TreeNode;
  /** For strict-extra violations: what kind of entry sits on disk. */
  entryKind?: "file" | "dir";
}

/** A preset expands to a set of attributes. Values are item lists,
 *  null for flags. Defined in the draft with `preset name { … }`. */
export type ProfileMap = Record<
  string,
  { doc?: string; expands: Record<string, string[] | null> }
>;
