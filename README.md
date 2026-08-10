# Drafteine

[![CI](https://github.com/owenddawson/drafteine/actions/workflows/ci.yml/badge.svg)](https://github.com/owenddawson/drafteine/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/owenddawson/drafteine?include_prereleases&label=release)](https://github.com/owenddawson/drafteine/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Draft it like text · read it like a tree · materialize it for real.**

Drafteine is a small indentation-driven language and toolchain for
drafting, materializing, and enforcing file trees. You type an outline;
the tooling parses it continuously, renders a live file-tree preview,
materializes the missing pieces (never overwriting), and holds the
directory to the contract from then on — in your editor, in CI, and
across AI-agent sessions.

Invalid lines never blank the preview: they render in place, flagged with
the error, and are simply excluded from the plan.

```
drafteine 1

preset code { max-lines: 400 }

drafteine/ { strict, allow: [dist/, node_modules/] }
  src/ { preset: code }
    main.cpp { template: cpp-main }
  test/
    parser.test.js
  docs/?
  README.md
```

Folders end with `/`, attributes sit in a `{ }` container, a trailing
`?` marks an entry optional, and policy presets are defined in the draft
itself. A sparse contract can skip the tree entirely and govern a few
spots by path:

```
drafteine 1

src/legacy/db.ts { max-lines: 900 } # the one file we watch
packages/core/src/ { strict, max-lines: 500 }
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

**Agent workflow — the planning agent proposes a contract, the human
reviews ten lines instead of forty file creations, the implementing
agent is held to it:**

```sh
claude -p "draft a folder layout for a fastify + drizzle api as drafteine" \
  | drafteine plan          # review the proposal
  | # looks right? apply it, then: drafteine check --all after every change set
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
npm install -g drafteine   # or ad hoc: npx drafteine <verb>
```

```sh
drafteine plan     structure.dft            # show what apply would create
drafteine apply    structure.dft --root .   # create it (never overwrites)
drafteine tree     structure.dft            # ASCII render
drafteine snapshot . > structure.dft        # real directory → draft
drafteine check    structure.dft            # verify reality conforms
drafteine fmt      structure.dft --write    # canonical formatting
drafteine codeowners structure.dft --out CODEOWNERS   # ownership from owner:
drafteine accept   structure.dft            # declare drift into the draft
drafteine check    --all                    # every contract in the config
drafteine explain  src/deep/file.ts         # effective policy, with sources
drafteine check    --all --format markdown  # drift report for a PR comment
drafteine check    --all --format sarif     # GitHub code scanning ingestion
```

`check` enforces contracts: missing drafted entries, type mismatches,
`strict` folder extras (`allow:` patterns tolerated), `forbidden` paths,
`ban: [*.bak]` subtree pattern bans, `count:` budgets, and `max-lines:`
/ `max-size:` violations, with exit code 1 for CI. Folder-level metrics are recursive defaults, a file's own
attribute overrides. `codeowners --check` gates CI on the generated file
being in sync. `-` or piped stdin works everywhere a file does.

## CI enforcement

Structure drift only surfaces where something runs `check`. On GitHub,
one step does it:

```yaml
- uses: owenddawson/drafteine@main
  # inputs: version (@drafteine/cli version), root (config directory)
```

Anywhere else (Codeberg/Forgejo, GitLab, plain shell), the action is
just this one line:

```sh
npx --yes drafteine check --all
```

Exit code 1 on violations fails the build. `codeowners --check` and
`fmt structure.dft --check` slot in beside it for full-contract CI.

## Holding agents to the contract

Drafteine's sharpest use case is the gap between an agent that plans and
an agent that builds. Prose plans get reinterpreted; a contract gets
checked.

1. **Plan.** The planning agent proposes `structure.dft` (ask it for
   "the layout as drafteine"). You review ten lines instead of forty
   file creations.
2. **Materialize.** `drafteine apply structure.dft` creates the skeleton
   and never overwrites.
3. **Enforce while the agent works.** `drafteine init --agents` writes
   the ground rules into `AGENTS.md`. For Claude Code, a Stop hook makes
   the loop mechanical — the agent cannot end its turn while the
   contract is violated, and the violations feed straight back to it:

   ```json
   {
     "hooks": {
       "Stop": [
         { "hooks": [{ "type": "command",
             "command": "npx --yes drafteine check --all 1>&2 || exit 2" }] }
       ]
     }
   }
   ```

4. **Backstop in CI.** The action above catches whatever slips through,
   on every pull request, human or agent.

Structure changes then arrive as reviewable `structure.dft` diffs, and
`drafteine accept` stays a human decision.

## The VS Code extension

`packages/vscode-extension` — packaged as `drafteine-*.vsix`
(`code --install-extension <file>`). Diagnostics as you type, attribute
completions with docs and examples inside `{ }`, hover, outline, folding,
Format Document, a live preview panel, one-click Apply, and continuous
contract checking: declare contracts in `drafteine.config.json` (or a
`"drafteine"` key in package.json) and violations appear in the Problems
panel with Explorer badges as you work.

```json
{
  "contracts": [{ "draft": "structure.dft", "root": "." }],
  "templates": "./drafteine-templates",
  "annotations": [
    { "name": "jira", "value": "string", "doc": "Tracking ticket." }
  ]
}
```

The config is machine-local plumbing only — policy lives in the draft,
where it reviews. It is plain JSON with a bundled schema: completion,
hover docs, and validation come from your editor's standard JSON
tooling, exactly like tsconfig.json.

`templates` names a directory whose files back `template:` entries at
apply time (verbatim, preflighted, never overwriting). `annotations`
declares custom attribute vocabulary that completes and hovers like
built-ins.

## Layout

- `packages/core` — the language: parser, formatter, plan, check. Zero deps, typed, no DOM.
- `packages/cli` — the `drafteine` command (`@drafteine/cli`).
- `packages/drafteine` — the flagship npm name, a thin doorway to the CLI.
- `packages/language-server` — LSP server (diagnostics, completions, hover, symbols) for any editor.
- `packages/vscode-extension` — LSP client, TextMate grammar, preview, apply, check watcher.
- `playground/` — the browser demo (CodeMirror 6).
