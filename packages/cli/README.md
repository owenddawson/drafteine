# @drafteine/cli

The `drafteine` command: draft, materialize, and enforce file trees.

```sh
drafteine init --agents      # scaffold a contract and agent rules
drafteine plan  structure.dft
drafteine apply structure.dft
drafteine check --all        # every contract in the config, CI-ready
drafteine accept structure.dft
drafteine fmt   structure.dft --check
drafteine codeowners structure.dft --out CODEOWNERS
drafteine tree  structure.dft --json
drafteine docs  structure.dft
drafteine owner src/billing/api.ts
drafteine snapshot . --gitignore
```

Every verb reads stdin with `-`. Exit codes: 0 ok, 1 violations or draft
errors, 2 usage or io errors.
