# Changelog

Granular per-release history begins with the first published release.
Everything below was built pre-release.

## 0.15.0 (unreleased)

**Language.** Version pragma: `drafteine 1` as the first content line
declares the draft's format version. Optional, and absence means format 1
permanently. Newer-format drafts parse best-effort with a warning, while
`fmt`, `accept`, and `apply` refuse to act on them (the no-rewrite rule).
Malformed pragmas diagnose instead of silently parsing as files, and
pragma-shaped names quote to stay files. `init` and `snapshot` emit the
pragma in generated drafts.

## 0.14.0 (pre-release state)

**Language.** Indentation-driven tree grammar with unit inference, quoting,
comma-list annotation values, `{ }` block form, comments, and normative
error tolerance. Annotations: `@strict`, `@allow`, `@optional`,
`@forbidden`, `@count`, `@max-lines`, `@max-size`, `@owner`, `@template`,
plus config-declared custom vocabulary and attribute profiles with
deterministic precedence. Folder metrics inherit; membership stays local.
Case-collision siblings warn.

**CLI.** `plan`, `apply` (template directory, preflighted, never
overwrites), `tree` (ASCII and `--json`), `snapshot` (`--gitignore`),
`check` (single contract, `--all` orchestration, `--json`), `accept`
(snapshot-style reconciliation, `--prune`), `fmt` (`--check` with unified
diff, opt-in `--align`), `codeowners` (generate and `--check`), `docs`
(markdown repo map). Stdin everywhere with `-`.

**Library.** `@drafteine/core`: zero-dependency typed ESM parser,
formatter, plan, `runApply`, `runCheck`, `acceptViolations`,
`applyProfiles`, vocabulary validation, all filesystem access injectable.

**Language server.** Diagnostics, completions with documentation and
examples, hover for annotations and entries, formatting, document
symbols, folding, quick fixes. Custom vocabulary and profiles surface in
IntelliSense.

**VS Code extension.** LSP client, TextMate grammar, live preview panel
with collapsible folders and theme preference (colored with manila
folders and GitHub Linguist file colors, minimal, espresso), markdown
```drafteine fence rendering, continuous contract checking with Problems
diagnostics and Explorer badges, one-click apply, structure view toggle.

**Project.** The repository is governed by its own contract
(`structure.dft`), which has caught its authors four times.
