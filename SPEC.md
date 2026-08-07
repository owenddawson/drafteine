# Drafteine language spec — v0.1

Drafteine is a line-based, indentation-driven notation for drafting file trees.
The design rule behind every decision here: **the syntax should visually
resemble the thing it produces.** A Drafteine document pasted into a chat
message or README should still read as a file tree with no tooling at all.

## Lines

A document is a sequence of lines. Each line is one of:

| Line | Meaning |
|---|---|
| `name/` | a **folder** (trailing slash) |
| `name` | a **file** (anything without a trailing slash) |
| `# text` | a **comment** — structurally invisible |
| *(blank)* | ignored |

## Nesting

Indentation is the nesting mechanism — there are no position macros.
The canonical unit is **two spaces**, but the parser infers the document's
unit from its first space-indented line — a pasted 4-space (or 3-space)
tree parses cleanly, and `fmt` normalizes it to the 2-space canon. A
literal tab always counts as one level; mixing tabs and spaces in one
line's indent is a warning.

```
app/
  src/
    main.cpp
  README.md
```

A line may indent at most one level deeper than the nearest structural line
above it, and only if that line is a folder. Files cannot contain children.

## Annotations

Behavior attaches to a line as trailing annotations, after the name:

```
main.cpp @template(cpp-main)
.gitignore @template(node) @perm(644)
```

- `@word` — a flag annotation.
- `@word(value)` — an annotation with a value.

`@` and `#` only begin an annotation or comment when **preceded by
whitespace**. Inside a name they are ordinary characters, so `@types/`,
`file@2x.png`, and `notes#1.md` are all valid names:

```
@types/
  file@2x.png @optional # trailing comment
```

`v0.1` recognizes `@template(name)` in the materialization plan; other keys
parse fine and are carried through for future use. A trailing `# comment`
may follow the annotations.

**Quoting (v0.2).** Names and annotation values may be double-quoted, with
`\"` and `\\` as the only escapes:

```
"release @ 2x"/
  "notes #draft.md" @template("weird (name)")
```

- A quoted name may be followed by `/` (outside the quotes) to mark a folder.
- Quoting exists for **syntax collisions** (leading `#`, interior ` @` /
  ` #`, leading/trailing spaces) — the forbidden path characters
  (`\ : * ? " < > |`) stay forbidden even inside quotes.
- Bare values may not contain `)`; quote them when they must.
- The canonical formatter quotes only when necessary.
- List values (`@allow("*.md", "*.txt")`) are reserved for v0.3.

**Block form (v0.2).** When a line accumulates too many annotations to
read, they can break onto their own lines. Block annotations are the
*same* `@` syntax, one per line — there is exactly one attribute language,
inline or expanded:

```
main.cpp {
  @template(cpp-main)
  @max-lines(200)
  @optional
}
```

The `{` ends the entry's line (a trailing `# comment` may follow it);
`}` closes alone on its line; annotation-line indentation is free-form
(canonically one level deeper). Inline and block forms are semantically
identical. `fmt` preserves the author's chosen form, expanding an inline
line to a block only when it passes 80 columns. Children of a folder
follow after its closing `}`.

**Formatting.** `drafteine fmt` produces the canonical form: 2-space
indentation, single-spaced annotations, minimal quoting, blank-line runs
collapsed to one. Lines carrying errors are left verbatim — the formatter
never rewrites what it cannot fully parse. `fmt --check` (exit 1 when
unformatted) is the CI hook; `fmt --write` rewrites in place.

## Names

Anything except `\ : * ? " < > |` and interior `/`. Interior spaces are
legal (`my docs/`). `.` and `..` are rejected. Leading/trailing whitespace
is trimmed.

## Error recovery (normative)

Drafteine is **error-tolerant by construction**. Invalid lines are never
dropped from the preview — they render in place, flagged. The rules:

1. **Over-indentation** — depth is clamped to the deepest legal level, with
   an error. The line still joins the tree at the clamped depth.
2. **Child of a file** — error on the child; clamped beside the file.
3. **Odd indentation** (not a multiple of 2) — warning; rounds down.
4. **Forbidden characters / interior slash / empty name** — error on the
   name span.
5. **Duplicate sibling names** — warning; both stay in the tree.
6. **Unrecognized trailing text** — error on the remainder of the line.

**Only clean lines reach the materialization plan.** An error anywhere on a
line excludes that line (and, for a folder, everything it would contain is
re-rooted per rule 1's clamping) from generated operations — errors can
never create wrong things on disk.

## Materialization

A document compiles to an ordered operation list, depth-first:

```
mkdir app/
mkdir app/src/
touch app/src/main.cpp   ← template: cpp-main
touch app/README.md
```

Materialization is declarative and idempotent: existing entries are
never touched, missing ones are created.

**Templates.** Config names one local **template directory**
(`"templates": "./drafteine-templates"`). `@template(path)` on a file
makes `apply` write that template's bytes verbatim instead of an empty
file. The value is a relative path inside the directory: absolute paths,
`..`, symlinks, and non-files are rejected. Apply preflights every
referenced template and aborts before creating anything if any is
missing — no half-applied trees. Files only (`@template` on a folder is
an error), no substitution or placeholders, no remote sources. The
never-overwrite rule is absolute, templated or not.

## Editor behavior (informative)

- **Tab / Shift-Tab** move a line between *valid* indentation levels only —
  Tab never creates an over-indented line. Smart tabs are an editor
  affordance, not language semantics.
- **Enter** inherits the current line's indentation; Enter at the end of a
  folder line opens one level deeper.
- Parsing is continuous; there is no "commit" keystroke. The preview is
  always live and always partial-tolerant.

## Check semantics (v0.2)

There are **no file modes**: a `.dft` document is not inherently a proposal
or a contract — *the verb decides what the document means*.

- `apply` reads entries as **"create these"** (missing → created,
  existing → skipped).
- `check` reads entries as **"these must exist"** (missing → violation,
  extra files → fine by default — the open world assumption).
- `@strict` on a folder closes its world: entries not present in the
  draft become violations ("undeclared direct child"). Sprawl enforcement
  is opt-in, per folder — strictness applies to a folder's **direct
  children only** and is *not* recursive; nested folders declare their
  own `@strict`.
- `@allow(patterns)` on a `@strict` folder tolerates extras matching the
  comma-separated patterns: `*` and `?` match within a name (never `/`),
  a trailing slash makes a pattern match directories only, and an
  admitted directory's contents stay unchecked unless separately drafted.
  Tolerated file extras still honor the folder's metric defaults.
  `ext/ @strict @allow(dist/, node_modules/, *.vsix)`. Annotation values
  are comma-separated lists in general; quote an item to include commas
  or parentheses.
- `@optional` marks an entry `check` won't require (but `apply` still
  creates). If an optional entry **is** present, it must still conform —
  type, `@max-lines`, and its subtree are checked normally.
- `@forbidden` on an entry: `check` fails if it exists, and `apply` never
  creates it. Bans dumping grounds and legacy paths by name.
- `@count(n)` on a folder: `check` fails when the folder has more than
  `n` direct entries on disk. Folder-local, never inherited.
- Siblings whose names differ only by letter case draw a parser warning,
  because case-insensitive filesystems treat them as one entry.
- `@max-lines(n)` on a file: `check` fails if the file exceeds `n` lines.
  `@max-size(n)` bounds a file's bytes (`k`/`m` suffixes, 1000-based).
  File metrics stay in a deliberately tiny, language-neutral family.
  Drafteine will never parse file *contents* semantically — code quality
  belongs to real linters.

**Inheritance is per-annotation, not a universal feature:**

| Annotation | On a file | On a folder |
|---|---|---|
| `@max-lines`, `@max-size` | constraint | **recursive default** for descendant files |
| `@owner` | owner | recursive ownership (via CODEOWNERS pattern semantics) |
| `@strict`, `@optional`, `@forbidden`, `@count` | local | local — never inherits |

Resolution for metric defaults: the file's own annotation wins, else the
nearest annotated ancestor folder, else no constraint. A nested folder's
default overrides its parent's for its whole subtree. Repeating an
annotation key on one entry is an error — defaults never combine. `fmt`
keeps defaults on the folder and never expands them onto files. The
asymmetry is deliberate: a metric on a folder naturally describes its
descendants, while `@strict` describes that folder's own contract.

## Attribute profiles

A profile is a named policy preset declared in config, never in drafts:

```json
"profiles": [
  { "name": "pkg", "doc": "Workspace package root.",
    "expands": { "allow": ["dist/", "node_modules/"] } }
]
```

Writing `core/ @strict @pkg` behaves exactly as if the expanded
annotations were written on the entry, including folder-default
inheritance. Precedence: inherited defaults < profile expansion <
explicit annotations (an explicit override emits an info diagnostic).
Two profiles disagreeing on a key is an error. Profiles carry policy
metadata only — they may never expand to `@strict` or `@optional`
(structure stays visibly explicit), never take parameters, and never
reference other profiles. `fmt` never expands profiles into drafts.

## Ownership

`@owner(name)` declares ownership; folder owners cover their subtree.
`drafteine codeowners draft.dft [--out FILE] [--check]` compiles the
annotations into a platform CODEOWNERS file — parents emit before
children so deeper rules override (CODEOWNERS applies the last matching
rule), bare tokens get an `@` prefix, and enforcement stays where it
belongs: the platform's branch protection. `--check` gates CI on the
generated file being in sync.

**Accepting drift.** `drafteine accept draft.dft` reconciles the draft
with reality the way snapshot tests update: strict-folder extras get
declared (directories shallow and unsealed, conspicuously reported),
and with `--prune` drafted-but-missing entries and their subtrees are
removed. Policy violations — metrics, `@forbidden`, `@count` — and type
mismatches are never auto-amended; they exit 1 as decisions left. The
git diff of the draft is the review step.

A proposal pasted in a README is therefore *also* a valid weak contract,
and promoting it to an enforced structure is a matter of where you point
`check` — not of rewriting the file. v1 check semantics stay deliberately
small: literal names, `*`/`**` globs, `@optional`, `@strict`, `@forbidden`,
possibly `@count`. Conditional logic is permanently out of scope — the
moment a draft stops reading as a tree, the format has lost its reason to
exist.

## Reserved for future versions


- **Other block types** — the outline grammar is deliberately generic;
  task lists, tables, and diagrams can become sibling block types with
  their own preview plugins.
- **Variables / repetition** — `@each`, glob-style expansion.
