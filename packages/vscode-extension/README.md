# Drafteine for VS Code

Language support for `.dft` file-tree drafts:

- **Diagnostics as you type** — over-indentation, files with children,
  invalid names, duplicate siblings, all from the Drafteine language server.
- **IntelliSense** — type `{` for attribute completions with docs;
  hover any attribute for its meaning.
- **Format** — the canonical Drafteine formatter, wired to *Format Document*.
- **Outline & folding** — the draft's tree structure in the Outline view.
- **Live preview** — `Drafteine: Open Preview to the Side`.
- **Materialize** — `Drafteine: Apply Draft to Workspace` creates the
  drafted folders and files (never overwrites anything).

## Syntax

```
app/ { strict }
  src/
    main.ts { max-lines: 200 }
  README.md          # folders end with /, files don't
```

See the repository's SPEC.md for the full language.
