# Contributing to Drafteine

Drafteine is a small language and toolchain for drafting, materializing, and
enforcing file structure. Thanks for helping.

## Development setup

Development needs Node 22 or newer, the test suite runs TypeScript
directly through the built-in type stripping. Published packages
themselves run on Node 18+.

```sh
npm install
npm test              # every workspace test suite
npm run lint          # eslint over all packages
npm run typecheck     # tsc over all five projects, sources and tests
npm run dev           # the browser playground
npx drafteine check --all   # the repo checks itself against structure.dft
```

All five gates must pass before a change is done: tests, lint, typecheck,
`check --all`, and `fmt --check structure.dft` if you touched the contract.

## The repo governs itself

`structure.dft` at the root is a real Drafteine contract. If you add a
source file, declare it there (or run `drafteine accept structure.dft` and
review the diff). Metric ceilings are sprawl tripwires: when one fires,
prefer splitting the file over raising the ceiling, and say which you did.

## Code style

- TypeScript strict everywhere. Build configs are `tsconfig.build.json`;
  plain `tsconfig.json` is for editors and covers tests too.
- Prose inside code — comments, hover docs, diagnostic messages — uses
  plain sentences. No em-dashes, no semicolons in prose. Describe exactly
  what something does.
- Diagnostics follow the pattern `path: what is wrong` and never blame.
- Every source file opens with a short header comment saying what it is.
- Tests live in each package's `test/` and run on plain `node --test`.

## Design principles (the short version)

1. A draft must read as a tree with zero training. Syntax that breaks the
   silhouette is wrong.
2. Meaning is local. Constraints that tighten (metrics) may inherit from
   folders; anything that loosens (`@allow`) must be written where it
   applies. `@strict` seals direct children only.
3. The verb decides semantics: `apply` creates, `check` enforces, the
   file has no modes.
4. Error tolerance is normative: invalid lines render flagged, never
   vanish, and never reach enforcement or disk.
5. Membership changes may be automated (`accept`); policy changes are
   human decisions.

**Permanent refusals** (please do not open proposals for these): in-draft
definitions or macros, conditionals or parameterized profiles, reading
file contents semantically, path interpolation, a second attribute
syntax. See SPEC.md for the reasoning.

Language and syntax changes need a discussion issue before code. This
project runs significant designs through adversarial review; expect
proposals to be stress-tested.

## Things contributors could actually do

- Editor integrations: a JetBrains plugin (LSP client + JCEF preview), a
  Neovim plugin (tree render over `tree --json`, Nerd Font icons), Helix
  and Zed config recipes, a tree-sitter grammar.
- CI recipes: a GitHub Action wrapping `check --all`, `fmt --check`, and
  `codeowners --check`.
- Windows: run the suite, report path handling issues.
- Extension integration tests (`@vscode/test-electron`).
- SARIF output for `check --json`.
- Performance work: incremental checking for very large monorepos.
- Docs-site fence renderers (Docusaurus, MkDocs).
