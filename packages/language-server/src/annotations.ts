/**
 * The built-in annotation vocabulary. Single source of truth for
 * completions and hover docs. Custom vocabularies declared in
 * drafteine.config.json will merge into this table later.
 */

export interface AnnotationDoc {
  /** Snippet inserted on completion. $1 marks the cursor position. */
  snippet: string;
  /** Hover and completion documentation in markdown. */
  doc: string;
  /** Which entries it applies to. */
  appliesTo: "file" | "folder" | "both";
}

export const ANNOTATIONS: Record<string, AnnotationDoc> = {
  template: {
    snippet: "template($1)",
    doc: [
      "**@template(name)**",
      "",
      "Materialize this entry from a named template instead of empty.",
      "The plan carries the template name. Content resolution ships with the template registry.",
      "",
      "```drafteine",
      "src/",
      "  main.cpp @template(cpp-main)",
      "```",
    ].join("\n"),
    appliesTo: "both",
  },
  strict: {
    snippet: "strict",
    doc: [
      "**@strict**",
      "",
      "Check reports entries on disk that are not declared in this folder.",
      "Applies to direct children only. Nested folders declare their own @strict.",
      "",
      "```drafteine",
      "src/ @strict",
      "  main.ts",
      "  util.ts",
      "```",
      "",
      "A file added to `src/` without a matching draft line becomes a violation.",
    ].join("\n"),
    appliesTo: "folder",
  },
  optional: {
    snippet: "optional",
    doc: [
      "**@optional**",
      "",
      "Check does not require this entry to exist.",
      "When it does exist, it must still conform. Apply still creates it.",
      "",
      "```drafteine",
      "docs/",
      "  adr/ @optional",
      "```",
    ].join("\n"),
    appliesTo: "both",
  },
  "max-lines": {
    snippet: "max-lines($1)",
    doc: [
      "**@max-lines(n)**",
      "",
      "Check fails when a file exceeds n lines.",
      "On a folder it is a recursive default for every file inside.",
      "A file's own annotation overrides the nearest folder default.",
      "",
      "```drafteine",
      "src/ @max-lines(300)",
      "  parser.ts",
      "  generated.ts @max-lines(2000)",
      "```",
    ].join("\n"),
    appliesTo: "both",
  },
  "max-size": {
    snippet: "max-size($1)",
    doc: [
      "**@max-size(n)**",
      "",
      "Check fails when a file exceeds n bytes. Suffixes k and m are",
      "1000 based. On a folder it is a recursive default, and a file's",
      "own annotation overrides it.",
      "",
      "```drafteine",
      "assets/ @max-size(500k)",
      "  hero.png",
      "```",
    ].join("\n"),
    appliesTo: "both",
  },
  allow: {
    snippet: "allow($1)",
    doc: [
      "**@allow(patterns)**",
      "",
      "On a @strict folder, extras matching these patterns are tolerated.",
      "Comma separated. * and ? match within a name. A trailing slash",
      "matches directories only. Tolerated files still honor the folder's",
      "metric defaults.",
      "",
      "```drafteine",
      "ext/ @strict @allow(dist/, node_modules/, *.vsix)",
      "  package.json",
      "```",
    ].join("\n"),
    appliesTo: "folder",
  },
  forbidden: {
    snippet: "forbidden",
    doc: [
      "**@forbidden**",
      "",
      "Check fails when this entry exists on disk. Apply never creates it.",
      "Use it to ban dumping grounds and legacy paths by name.",
      "",
      "```drafteine",
      "src/",
      "  utils/ @forbidden # no junk-drawer folder",
      "```",
    ].join("\n"),
    appliesTo: "both",
  },
  count: {
    snippet: "count($1)",
    doc: [
      "**@count(n)**",
      "",
      "Check fails when this folder has more than n direct entries on",
      "disk. Applies to this folder only, never inherited.",
      "",
      "```drafteine",
      "scripts/ @count(12)",
      "```",
    ].join("\n"),
    appliesTo: "folder",
  },
  owner: {
    snippet: "owner($1)",
    doc: [
      "**@owner(name)**",
      "",
      "Declares who owns this entry. Folder owners cover their subtree.",
      "The codeowners verb generates a CODEOWNERS file from these,",
      "and bare names get an @ prefix.",
      "",
      "```drafteine",
      "billing/ @owner(@org/billing-team)",
      "  api.ts",
      "```",
    ].join("\n"),
    appliesTo: "both",
  },
};

/** Hover text for an annotation key, or null when the key is unknown. */
export function hoverDoc(key: string): string | null {
  const a = ANNOTATIONS[key];
  return a ? a.doc : null;
}
