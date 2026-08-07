# Drafteine

[![CI](https://github.com/owenddawson/drafteine/actions/workflows/ci.yml/badge.svg)](https://github.com/owenddawson/drafteine/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/owenddawson/drafteine?include_prereleases&label=release)](https://github.com/owenddawson/drafteine/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Draft it like text · read it like a tree · materialize it for real.**

Drafteine is an IDE-style productivity tool built around a small
indentation-driven language for drafting file trees. You type an outline;
the editor parses it continuously, renders a live file-tree preview, and
produces a materialization plan — the exact `mkdir`/`touch` operations that
would turn your draft into a real directory structure.

Invalid lines never blank the preview: they render in place, flagged with
the error, and are simply excluded from the plan.

```
drafteine/
  src/
    main.cpp @template(cpp-main)
  test/
    parser.test.js
  README.md
```

See [SPEC.md](SPEC.md) for the language specification.

## Drafteine in Markdown

A drafteine block degrades gracefully: renderers that don't know the fence
show a code block that *already reads as a file tree*. Renderers that do
can preview it — and a reader can pipe it straight into the CLI.

**Propose a structure in a PR or design doc:**

````markdown
```drafteine
services/
  billing/
    api/
    domain/
    billing.test.ts
  shared/          # extracted from billing + accounts
    money.ts
```
````

**Tutorial setup — readers apply instead of hand-typing mkdir:**

````markdown
```drafteine
my-first-extension/
  manifest.json
  src/
    background.js
    content.js
  icons/
```

Copy the block into a file (or your clipboard) and run:
`drafteine apply setup.dft` — or `pbpaste | drafteine apply`
````

**Agent workflow — the agent proposes, the human reviews ten lines
instead of forty file creations, then applies:**

```sh
claude -p "draft a folder layout for a fastify + drizzle api as drafteine" \
  | drafteine plan          # review the proposal
  | # looks right? run apply
```

## The library

`@drafteine/core` is dependency-free, typed, and runs anywhere JS runs
(Node, browsers, Bun, workers):

```ts
import { parse, plan } from "@drafteine/core";

const { root, diagnostics, stats } = parse("app/\n  src/\n    main.ts\n");
const ops = plan(root);
// [{ type: "mkdir", path: "app/" }, ..., { type: "touch", path: "app/src/main.ts" }]
```

## Run it

```sh
npm install
npm run dev        # playground: then open the printed localhost URL
npm test           # all workspace test suites
npm run lint       # eslint over every package
npm run typecheck  # tsc over every project
```

## The CLI

```sh
drafteine plan     structure.dft            # show what apply would create
drafteine apply    structure.dft --root .   # create it (never overwrites)
drafteine tree     structure.dft            # ASCII render
drafteine snapshot . > structure.dft        # real directory → draft
drafteine check    structure.dft            # verify reality conforms
drafteine fmt      structure.dft --write    # canonical formatting
drafteine codeowners structure.dft --out CODEOWNERS   # ownership from @owner
drafteine accept   structure.dft            # declare drift into the draft
drafteine check    --all                    # every contract in the config
```

`check` enforces contracts: missing drafted entries, type mismatches,
`@strict` folder extras (`@allow` patterns tolerated), and `@max-lines`
/ `@max-size` violations, with exit code 1 for CI. Folder-level metric
annotations are recursive defaults, a file's own annotation overrides.
`codeowners --check` gates CI on the generated file being in sync.
`-` or piped stdin works everywhere a file does.

## The VS Code extension

`packages/vscode-extension` — packaged as `drafteine-*.vsix`
(`code --install-extension <file>`). Diagnostics as you type, `@`
completions with docs and examples, hover, outline, folding, Format
Document, a live preview panel, one-click Apply, and continuous contract
checking: declare contracts in `drafteine.config.json` (or a
`"drafteine"` key in package.json) and violations appear in the Problems
panel with Explorer badges as you work.

```json
{
  "contracts": [{ "draft": "structure.dft", "root": "." }],
  "templates": "./drafteine-templates",
  "profiles": [
    { "name": "pkg", "doc": "Workspace package root.",
      "expands": { "allow": ["dist/", "node_modules/"] } }
  ],
  "annotations": [
    { "name": "jira", "value": "string", "doc": "Tracking ticket." }
  ]
}
```

The config is plain JSON with a bundled schema: completion, hover docs,
and validation come from your editor's standard JSON tooling, exactly
like tsconfig.json.

`templates` names a directory whose files back `@template(path)` entries
at apply time (verbatim, preflighted, never overwriting). `profiles` are
named policy presets: `core/ @strict @pkg` behaves as if the expanded
annotations were written on the entry. `annotations` declares custom
vocabulary that completes and hovers like built-ins.

## Layout

- `packages/core` — the language: parser, formatter, plan, check. Zero deps, typed, no DOM.
- `packages/cli` — the `drafteine` command.
- `packages/language-server` — LSP server (diagnostics, completions, hover, symbols) for any editor.
- `packages/vscode-extension` — LSP client, TextMate grammar, preview, apply, check watcher.
- `playground/` — the browser demo (CodeMirror 6).
