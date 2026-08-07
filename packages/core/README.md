# @drafteine/core

Parser, formatter, plan, apply, check, accept, and profiles for the
Drafteine file-tree language. Zero dependencies, fully typed, pure ESM,
runs in Node, browsers, and workers. All filesystem access is injectable.

```ts
import { parse, plan, runCheck } from "@drafteine/core";

const { root, diagnostics } = parse("app/ @strict\n  main.ts @max-lines(200)\n");
```

Part of Drafteine: draft file trees as text, preview them live,
materialize and enforce them for real. See the repository for the full
language spec and CLI.
