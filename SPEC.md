# Drafteine language spec — format 1

Drafteine is a line-based, indentation-driven notation for drafting and
enforcing file trees. The design rule behind every decision here: **the
syntax should visually resemble the thing it produces.** A Drafteine
document pasted into a chat message or README should still read as a
file tree with no tooling at all.

## Lines

A document is a sequence of lines. Each line is one of:

| Line | Meaning |
|---|---|
| `drafteine 1` | the **version pragma** (first content line only) |
| `preset name { … }` | a **preset definition** (unindented only) |
| `name/` | a **folder** (trailing slash) |
| `name` | a **file** (anything without a trailing slash) |
| `a/b/c.ts` | a **path line** — one deep entry, ancestors implied |
| `# text` | a **comment** — structurally invisible |
| *(blank)* | ignored |

Entries may carry a trailing `?` sigil and an `{ attribute }` container,
described below.

## Version pragma

A draft may declare its format with `drafteine <number>` as the **first
non-blank, non-comment line**, unindented. A trailing `# comment` may
follow the number. The version is a whole number with no leading zeros,
bumped only on breaking grammar or semantics changes.

```
drafteine 1

src/
  main.ts
```

- The pragma is **optional, and absence means format 1 — permanently.**
  An unversioned draft never changes meaning when the format grows.
- A draft declaring a **newer** format than the tool implements draws a
  warning and is read best-effort (per the error-tolerance rules). But
  verbs that rewrite the draft or act on it (`fmt`, `accept`, `apply`)
  **refuse**: best-effort reading is graceful degradation, best-effort
  rewriting is corruption. Text after a newer version number is
  tolerated, it may be meaningful in that format.
- A first content line shaped like `drafteine <digit>…` that fails the
  form (`drafteine 1.0`, `drafteine 01`) is a **malformed pragma error**,
  never silently a file. Elsewhere in the document, a line matching the
  pragma shape parses as a file with a warning. A real file named
  `drafteine 1` is declared by quoting: `"drafteine 1"` — `fmt` quotes
  such names automatically.
- Tools never insert a missing pragma into an existing draft; `fmt` only
  canonicalizes one already present. Generated drafts (`init`,
  `snapshot`) start with `drafteine 1`.

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

## Attributes

Behavior attaches to an entry in a single `{ … }` **container** after
the name. There is exactly one attribute grammar:

```
packages/ { owner: @core, strict, count: 6 } # comment
  core/ { strict, preset: pkg }
    generated.ts { max-lines: 2000 }
```

- A bare word is a **flag**: `strict`, `forbidden`.
- `key: value` attaches a **value**. Bare values run to the next `,`,
  `}`, `]`, or `#`; interior spaces are fine (`owner: @org/team lead@x.com`).
  Quote a value only for those collision characters.
- **Lists** sit in brackets: `allow: [dist/, node_modules/, *.vsix]`.
  Lists never nest. A single-item value needs no brackets, and `fmt`
  writes it bare.
- Comma separates items. Trailing commas are tolerated. `{ }` is valid
  and means nothing.
- Keys are words (`[A-Za-z][\w-]*`). Unknown keys are inert metadata:
  parsed, carried through, ignored by tools, available to yours.
  Duplicate keys on one entry are an error — values never combine.

**Expanded form.** When `{` ends the line (nothing after it but an
optional comment), the container expands: one item per line, closed by
`}` alone on its line. Inline and expanded are the *same construct* and
`fmt` expands any entry whose name and attributes pass 80 columns:

```
vscode-extension/ { # same attributes, one per line
  strict
  allow: [dist/, node_modules/, *.vsix]
}
```

Full-line `#` comments may sit between items. A `{` with same-line items
but no closing `}` is an error and never opens an expanded container.

**The `?` sigil.** A trailing `?` marks an entry optional — `check`
does not require it to exist, but a present entry must still conform.
Files: `notes.md?`. Folders: `vendor/?`. The word form `{ optional }`
parses and means the same; `fmt` rewrites it to the sigil. `?` is a
forbidden path character on every platform, so the sigil is never
ambiguous with a real name. Combining `forbidden` with `?` (or
`optional`) is an error: forbidden replaces presence rules.

## Names

Anything except `\ : * ? " < > |`. Interior spaces are legal
(`my docs/`). `.` and `..` are rejected. Leading/trailing whitespace is
trimmed. `#` only begins a comment when preceded by whitespace, so
`notes#1.md` and `file@2x.png` are ordinary names.

**Quoting.** Names may be double-quoted, with `\"` and `\\` as the only
escapes: `"release @ 2x"/`, `"notes #draft.md"?`. Quoting exists for
syntax collisions (leading `#`, interior ` #` or ` {` or ` @`, edge
whitespace, keyword-shaped names like `drafteine 1`) — the forbidden
path characters stay forbidden even inside quotes. A quoted name is a
**single segment**: it never reads as a path. The canonical formatter
quotes only when necessary.

Trailing `@word` annotations are pre-release syntax and draw a dedicated
error pointing at the container form.

## Path lines

A sparse contract does not pay for the whole tree. A bare name
containing `/` declares one deep entry in a single line — the pragmatic
register for governing a few spots in a large repo:

```
drafteine 1

src/legacy/db.ts { max-lines: 900 } # the one file we watch
packages/core/src/ { strict, max-lines: 500 }
docs/adr/ { count: 50 }
```

- Segments between `/` are ordinary names; the **leaf** carries the
  attributes and the trailing `/` or `?`.
- Intermediate segments become **implied folders**: required, unsealed,
  attribute-free. When a segment names an already-declared folder, the
  path merges into it; passing through a declared *file* is an error.
- Path lines nest like any line: indented under a folder they are
  relative to it, unindented they are relative to the root. Children may
  nest under a path line's leaf folder by indenting one level deeper.

## Presets

A preset is a named policy bundle defined **in the draft**, so the whole
contract — structure and the policy vocabulary it uses — reviews in one
diff. Machine-local plumbing (template directory, contract list, custom
attribute vocabulary) stays in config; policy never does.

```
preset pkg { allow: [dist/, node_modules/] } # workspace package root

core/ { strict, preset: pkg }
cli/ { strict, preset: pkg }
```

- Definitions are unindented `preset name { … }` lines, canonically at
  the top. A file legitimately named like one is declared by quoting.
- `preset: name` on an entry behaves exactly as if the preset's
  attributes were written there. **One preset per entry** — presets
  never compose, never take parameters, never reference other presets.
  A new combined preset is clearer than an override order dispute.
- Precedence: inherited defaults < preset expansion < explicit
  attributes. An explicit key overriding a preset value draws an info
  diagnostic. Referencing an undefined preset is an error.
- Presets carry **policy only**: `strict`, `optional`, `forbidden`, and
  `preset` may not live inside one. Structure stays visibly explicit on
  the entry.
- `fmt` never expands presets into entries, and generated projections
  (docs, previews) label expanded attributes rather than inlining them.

## Error recovery (normative)

Drafteine is **error-tolerant by construction**. Invalid lines are never
dropped from the preview — they render in place, flagged. The rules:

1. **Over-indentation** — depth is clamped to the deepest legal level, with
   an error. The line still joins the tree at the clamped depth.
2. **Child of a file** — error on the child; clamped beside the file.
3. **Odd indentation** (not a multiple of the unit) — warning; rounds down.
4. **Forbidden characters / dot names / empty segments** — error on the
   name span.
5. **Duplicate sibling names** — warning; both stay in the tree.
6. **Container faults never cross the physical line.** A malformed item
   reports and resynchronizes at the next comma, closing delimiter, or
   end of line. An unclosed inline `{` or `[` is an error on that line
   only. Comments are recognized before recovery, so a broken container
   cannot eat a trailing comment.
7. **Malformed version pragma** — error; the line is consumed as a pragma
   and never becomes a file. A pragma-shaped line after the first content
   line is a warning and parses as a file.
8. **Unrecognized trailing text** — error on the remainder of the line.

**Only clean lines reach enforcement and materialization.** An error
anywhere on a line excludes that line (and, for a path line, its implied
chain) from generated operations — errors can never create wrong things
on disk.

## Materialization

A document compiles to an ordered operation list, depth-first:

```
mkdir app/
mkdir app/src/
touch app/src/main.cpp   ← template: cpp/main.cpp
touch app/README.md
```

Materialization is declarative and idempotent: existing entries are
never touched, missing ones are created. Implied path-line folders
materialize like any other.

**Templates.** Config names one local **template directory**
(`"templates": "./drafteine-templates"`). `template: path` on a file
makes `apply` write that template's bytes verbatim instead of an empty
file. The value is a relative path inside the directory: absolute paths,
`..`, symlinks, and non-files are rejected. Apply preflights every
referenced template and aborts before creating anything if any is
missing — no half-applied trees. Files only (`template:` on a folder is
an error), no substitution or placeholders, no remote sources. The
never-overwrite rule is absolute, templated or not.

## Editor behavior (informative)

- **Tab / Shift-Tab** move a line between *valid* indentation levels only —
  Tab never creates an over-indented line. Smart tabs are an editor
  affordance, not language semantics.
- **Enter** inherits the current line's indentation; Enter at the end of a
  folder line opens one level deeper.
- Attribute completion offers keys inside `{ }` and preset names after
  `preset:`. Parsing is continuous; the preview is always live and
  always partial-tolerant.

## Check semantics

There are **no file modes**: a `.dft` document is not inherently a proposal
or a contract — *the verb decides what the document means*.

- `apply` reads entries as **"create these"** (missing → created,
  existing → skipped).
- `check` reads entries as **"these must exist"** (missing → violation,
  extra files → fine by default — the open world assumption).
- `strict` on a folder closes its world: entries not present in the
  draft become violations ("undeclared direct child"). Sprawl enforcement
  is opt-in, per folder — strictness applies to a folder's **direct
  children only** and is *not* recursive; nested folders declare their
  own `strict`.
- `allow: [patterns]` on a strict folder tolerates extras matching the
  patterns: `*` and `?` match within a name (never `/`), a trailing
  slash makes a pattern match directories only, and an admitted
  directory's contents stay unchecked unless separately drafted.
  Tolerated file extras still honor the folder's metric defaults.
- `?` marks an entry check won't require (but `apply` still creates).
  If an optional entry **is** present, it must still conform — type,
  metrics, and its subtree are checked normally.
- `forbidden` on an entry: `check` fails if it exists, and `apply` never
  creates it. Bans dumping grounds and legacy paths by name.
- `count: n` on a folder: `check` fails when the folder has more than
  `n` direct entries on disk. Folder-local, never inherited — a nested
  folder's budget is its own decision.
- Siblings whose names differ only by letter case draw a parser warning,
  because case-insensitive filesystems treat them as one entry.
- `max-lines: n` on a file: `check` fails if the file exceeds `n` lines.
  `max-size: n` bounds a file's bytes (`k`/`m` suffixes, 1000-based).
  File metrics stay in a deliberately tiny, language-neutral family.
  Drafteine will never parse file *contents* semantically — code quality
  belongs to real linters.

**Inheritance is per-attribute, not a universal feature:**

| Attribute | On a file | On a folder |
|---|---|---|
| `max-lines`, `max-size` | constraint | **recursive default** for descendant files |
| `owner` | owner | recursive ownership (via CODEOWNERS pattern semantics) |
| `strict`, `?`, `forbidden`, `count` | local | local — never inherits |

Resolution for metric defaults: the file's own attribute wins, else the
nearest annotated ancestor folder, else no constraint. A nested folder's
default overrides its parent's for its whole subtree, and an explicit
override may **loosen** as well as tighten — exempting the one generated
file is a legible, reviewable act, not a loophole. The asymmetry is
deliberate: a metric on a folder naturally describes its descendants,
while membership (`strict`, `count`) describes that folder's own
contract.

## Ownership

`owner: name` declares ownership; folder owners cover their subtree.
`drafteine codeowners draft.dft [--out FILE] [--check]` compiles the
attributes into a platform CODEOWNERS file — parents emit before
children so deeper rules override (CODEOWNERS applies the last matching
rule), bare tokens get an `@` prefix, and enforcement stays where it
belongs: the platform's branch protection. `--check` gates CI on the
generated file being in sync.

**Accepting drift.** `drafteine accept draft.dft` reconciles the draft
with reality the way snapshot tests update: strict-folder extras get
declared (directories shallow and unsealed, conspicuously reported),
and with `--prune` drafted-but-missing entries and their subtrees are
removed. Policy violations — metrics, `forbidden`, `count` — and type
mismatches are never auto-amended; they exit 1 as decisions left. The
git diff of the draft is the review step.

A proposal pasted in a README is therefore *also* a valid weak contract,
and promoting it to an enforced structure is a matter of where you point
`check` — not of rewriting the file. Conditional logic is permanently
out of scope — the moment a draft stops reading as a tree, the format
has lost its reason to exist.

## Reserved for future formats

- **Pattern bans** — `forbidden` on glob patterns, not just literal paths.
- **Other block types** — the outline grammar is deliberately generic;
  task lists, tables, and diagrams can become sibling block types with
  their own preview plugins.
- **Recursive sealing** — if per-folder `strict` proves too chatty on
  deep trees, a `strict: tree` value can arrive compatibly.
