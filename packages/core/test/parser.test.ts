import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, plan, toScript, format, quoteName, runCheck, applyProfiles, validateVocabulary, acceptViolations } from "../dist/index.js";

test("basic nesting: folders and files land at the right depth", () => {
  const { root, stats, diagnostics } = parse(
    ["app/", "  src/", "    main.cpp", "  README.md"].join("\n")
  );
  assert.equal(diagnostics.length, 0);
  assert.equal(stats.folders, 2);
  assert.equal(stats.files, 2);

  const app = root.children[0];
  assert.equal(app.name, "app");
  assert.ok(app.isFolder);
  const [src, readme] = app.children;
  assert.equal(src.name, "src");
  assert.equal(src.children[0].name, "main.cpp");
  assert.equal(readme.name, "README.md");
});

test("trailing slash decides folder vs file", () => {
  const { root } = parse("bin/\nbin");
  assert.ok(root.children[0].isFolder);
  assert.ok(!root.children[1].isFolder);
});

test("over-indentation is clamped, not dropped", () => {
  // Unit established as 2 by b/; 6 spaces = depth 3, but only depth 2 is open.
  const { root, diagnostics } = parse("app/\n  b/\n      too-deep.txt");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "error");
  // Clamped to depth 2: still a child of b/.
  assert.equal(root.children[0].children[0].children[0].name, "too-deep.txt");
});

test("children of a file are an error", () => {
  const { diagnostics } = parse("notes.txt\n  child.txt");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /Files cannot contain children/);
});

test("annotations parse with and without values", () => {
  const { lines } = parse("README.md @template(oss-readme) @ignore");
  const anns = lines[0].annotations;
  assert.deepEqual(
    anns.map((a) => [a.key, a.value]),
    [["template", "oss-readme"], ["ignore", null]]
  );
});

test("comments and blank lines are structurally invisible", () => {
  const { root, stats } = parse("# a comment\n\napp/\n  # nested comment\n  main.js");
  assert.equal(stats.folders, 1);
  assert.equal(stats.files, 1);
  assert.equal(root.children[0].children[0].name, "main.js");
});

test("forbidden characters and interior slashes are flagged", () => {
  const { diagnostics } = parse('bad:name.txt\nsrc/main.js');
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0].message, /not allowed/);
  assert.match(diagnostics[1].message, /only appear at the end/);
});

test("duplicate siblings warn but both stay in the tree", () => {
  const { root, diagnostics } = parse("a.txt\na.txt");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "warning");
  assert.equal(root.children.length, 2);
});

test("odd indentation warns and rounds down once a unit is established", () => {
  const { root, diagnostics } = parse("app/\n  two/\n   three.txt");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "warning");
  assert.match(diagnostics[0].message, /multiple of 2/);
  assert.equal(root.children[0].children[1].name, "three.txt"); // rounds to depth 1
});

test("indent unit is inferred from the document (4-space and tabs)", () => {
  const four = parse("app/\n    src/\n        main.ts");
  assert.equal(four.diagnostics.length, 0);
  assert.equal(four.indentUnit, 4);
  assert.equal(four.root.children[0].children[0].children[0].name, "main.ts");

  const tabs = parse("app/\n\tsrc/\n\t\tmain.ts");
  assert.equal(tabs.diagnostics.length, 0);
  assert.equal(tabs.root.children[0].children[0].children[0].name, "main.ts");
});

test("mixed tabs and spaces warn", () => {
  const { diagnostics } = parse("app/\n \tx.txt");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /Mixed tabs and spaces/);
});

test("block form attaches annotations to the entry", () => {
  const src = [
    "src/",
    "  template.js {",
    "    @max-lines(25)",
    "    @optional()",
    "  }",
    "README.md",
  ].join("\n");
  const { root, diagnostics, lines } = parse(src);
  assert.equal(diagnostics.length, 0);
  const tpl = root.children[0].children[0];
  assert.equal(tpl.name, "template.js");
  assert.deepEqual(tpl.annotations.map((a) => a.key), ["max-lines", "optional"]);
  assert.equal(lines[1].opensBlock, true);
  assert.equal(lines[2].kind, "annotation");
  assert.equal(lines[4].kind, "block-end");
  assert.equal(root.children[1].name, "README.md"); // children resume after }
});

test("unclosed block and unmatched brace are errors", () => {
  const open = parse("a.txt {\n  @optional");
  assert.equal(open.diagnostics.length, 1);
  assert.match(open.diagnostics[0].message, /Unclosed/);

  const stray = parse("a.txt\n}");
  assert.equal(stray.diagnostics.length, 1);
  assert.match(stray.diagnostics[0].message, /Unmatched/);
});

test("format preserves block form and regenerates it canonically", () => {
  const src = "src/\n    x.js {\n        @max-lines(25)\n      @optional()\n    }\n";
  const out = format(src);
  assert.equal(
    out,
    ["src/", "  x.js {", "    @max-lines(25)", "    @optional()", "  }"].join("\n") + "\n"
  );
  assert.equal(out, format(out)); // idempotent
});

test("plan skips error lines and orders depth-first", () => {
  const source = ["app/", "  src/", "    main.cpp @template(cpp-main)", "  bad:file", "docs/"].join("\n");
  const { root } = parse(source);
  const ops = plan(root);
  assert.deepEqual(
    ops.map((o) => [o.type, o.path]),
    [
      ["mkdir", "app/"],
      ["mkdir", "app/src/"],
      ["touch", "app/src/main.cpp"],
      ["mkdir", "docs/"],
    ]
  );
  assert.equal(ops[2].template, "cpp-main");
});

test("script output quotes paths that need it", () => {
  const { root } = parse("my docs/\n  a file.txt");
  const script = toScript(plan(root));
  assert.match(script, /mkdir -p 'my docs'/);
  assert.match(script, /touch 'my docs\/a file\.txt'/);
});

test("@ and # are only syntax when whitespace-preceded", () => {
  const { root, diagnostics } = parse(
    ["@types/", "  file@2x.png", "  notes#1.md @optional # trailing comment"].join("\n")
  );
  assert.equal(diagnostics.length, 0);
  const scoped = root.children[0];
  assert.equal(scoped.name, "@types");
  assert.ok(scoped.isFolder);
  assert.equal(scoped.children[0].name, "file@2x.png");
  const notes = scoped.children[1];
  assert.equal(notes.name, "notes#1.md");
  assert.deepEqual(notes.annotations.map((a) => a.key), ["optional"]);
});

test("dot and dot-dot names are rejected", () => {
  const { diagnostics } = parse("../\n./\n..");
  const errors = diagnostics.filter((d) => d.severity === "error");
  assert.equal(errors.length, 3); // a 4th diagnostic is the duplicate-name warning
  assert.ok(errors.every((d) => /not a valid name/.test(d.message)));
});

test("quoted names carry syntax characters literally", () => {
  const { root, diagnostics } = parse(
    ['"release @ 2x"/', '  "notes #draft.md" @optional', '  "#hash first.txt"'].join("\n")
  );
  assert.equal(diagnostics.length, 0);
  const folder = root.children[0];
  assert.equal(folder.name, "release @ 2x");
  assert.ok(folder.isFolder);
  assert.equal(folder.children[0].name, "notes #draft.md");
  assert.deepEqual(folder.children[0].annotations.map((a) => a.key), ["optional"]);
  assert.equal(folder.children[1].name, "#hash first.txt");

  // Quoting is for syntax collisions — forbidden path chars stay forbidden.
  const bad = parse('"say \\"hi\\".txt"');
  assert.equal(bad.diagnostics.length, 1);
  assert.match(bad.diagnostics[0].message, /not allowed/);
});

test("unterminated quote is an error, line stays visible", () => {
  const { lines, diagnostics } = parse('"broken.txt');
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /Unterminated/);
  assert.equal(lines[0].kind, "file");
});

test("quoted annotation values unescape", () => {
  const { lines } = parse('a.txt @template("weird (name)") @note("say \\"hi\\"")');
  assert.deepEqual(
    lines[0].annotations.map((a) => a.value),
    ["weird (name)", 'say "hi"']
  );
});

test("format canonicalizes and is idempotent", () => {
  const messy = [
    "app/   @strict",
    "",
    "",
    "  src/", // establishes the 2-space unit
    '    "main.ts"', // needlessly quoted
    "   three.txt", // odd indent: rounds down (warning, not error)
    "  README.md   # keep docs",
  ].join("\n");
  const once = format(messy);
  assert.equal(once, format(once));
  assert.equal(
    once,
    [
      "app/ @strict",
      "",
      "  src/",
      "    main.ts",
      "  three.txt",
      "  README.md # keep docs",
    ].join("\n") + "\n"
  );
});

test("format leaves error lines verbatim and quotes when needed", () => {
  const src = 'ok.txt\nbad:name.txt\n"needs @quote.txt"\n';
  const out = format(src);
  assert.match(out, /^ok\.txt\n/);
  assert.match(out, /bad:name\.txt/); // untouched despite error
  assert.match(out, /"needs @quote\.txt"/); // stays quoted — it must
  assert.equal(quoteName("plain.txt"), "plain.txt");
  assert.equal(quoteName("has @sign.txt"), '"has @sign.txt"');
});

test("folder metric defaults inherit, file annotations override", () => {
  const { root, diagnostics } = parse(
    [
      "src/ @max-lines(10)",
      "  big.ts",
      "  exempt.ts @max-lines(100)",
      "  nested/ @max-lines(50)",
      "    mid.ts",
    ].join("\n")
  );
  assert.equal(diagnostics.length, 0);
  const io = {
    kind: () => "file" as const,
    readdir: () => [],
    countLines: () => 30,
    fileSize: () => 0,
  };
  const kindFix = { ...io, kind: (p: string) => (p.includes(".") ? ("file" as const) : ("dir" as const)) };
  const violations = runCheck(root, kindFix);
  // big.ts inherits 10 and fails at 30. exempt.ts overrides to 100 and
  // passes. mid.ts inherits the nearer nested/ default of 50 and passes.
  assert.deepEqual(violations.map((v) => v.path), ["src/big.ts"]);
});

test("@max-size checks bytes with k and m suffixes", () => {
  const { root } = parse("assets/ @max-size(1k)\n  logo.png\n  video.mp4 @max-size(2m)");
  const io = {
    kind: (p: string) => (p.includes(".") ? ("file" as const) : ("dir" as const)),
    readdir: () => [],
    countLines: () => 0,
    fileSize: (p: string) => (p.endsWith(".png") ? 5000 : 1500000),
  };
  const violations = runCheck(root, io);
  assert.deepEqual(
    violations.map((v) => [v.kind, v.path]),
    [["max-size", "assets/logo.png"]] // video is under its own 2m override
  );
});

test("@allow tolerates matching extras in @strict folders", () => {
  const { root, diagnostics } = parse(
    'ext/ @strict @allow("*.vsix", dist/, node_modules/) @max-lines(10)\n  package.json'
  );
  assert.equal(diagnostics.length, 0);
  const world: Record<string, { kind: "file" | "dir"; lines: number }> = {
    "ext/package.json": { kind: "file", lines: 3 },
    "ext/drafteine-0.4.0.vsix": { kind: "file", lines: 99 },
    "ext/dist": { kind: "dir", lines: 0 },
    "ext/dist.txt": { kind: "file", lines: 1 }, // dist/ is dirs only
    "ext/big.vsix": { kind: "file", lines: 50 },
    "ext/rogue.ts": { kind: "file", lines: 1 },
  };
  const io = {
    kind: (p: string) => (p === "ext" ? ("dir" as const) : world[p]?.kind ?? ("missing" as const)),
    readdir: () => Object.keys(world).map((k) => k.slice(4)),
    countLines: (p: string) => world[p]?.lines ?? 0,
    fileSize: () => 0,
  };
  const violations = runCheck(root, io);
  const byPath = Object.fromEntries(violations.map((v) => [v.path, v.kind]));
  // rogue.ts and dist.txt are not allowed. The vsix files are tolerated,
  // but tolerated file extras still honor the folder's @max-lines default.
  assert.equal(byPath["ext/rogue.ts"], "strict-extra");
  assert.equal(byPath["ext/dist.txt"], "strict-extra");
  assert.equal(byPath["ext/drafteine-0.4.0.vsix"], "max-lines");
  assert.equal(byPath["ext/big.vsix"], "max-lines");
  assert.equal(byPath["ext/dist"], undefined);
  assert.equal(violations.length, 4);
});

test("annotation value lists parse and round-trip through fmt", () => {
  const src = 'ext/ @strict @allow("*.vsix", dist/, "with, comma")\n';
  const { lines, diagnostics } = parse(src);
  assert.equal(diagnostics.length, 0);
  const allow = lines[0].annotations.find((a) => a.key === "allow")!;
  assert.deepEqual(allow.values, ["*.vsix", "dist/", "with, comma"]);
  const out = format(src);
  // Unneeded quotes drop, the comma item keeps them, and it reparses identically.
  assert.equal(out, 'ext/ @strict @allow(*.vsix, dist/, "with, comma")\n');
  assert.equal(out, format(out));
});

test("duplicate annotations on one entry are errors", () => {
  const { diagnostics } = parse("a.ts @max-lines(10) @max-lines(20)");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /Duplicate @max-lines/);
  assert.equal(diagnostics[0].severity, "error");
});

test("profiles expand, explicit overrides, conflicts error", () => {
  const { parse: p2, applyProfiles: ap } = { parse, applyProfiles };
  const profiles = {
    pkg: { expands: { allow: ["dist/"], "max-lines": ["100"] } },
    tiny: { expands: { "max-lines": ["5"] } },
  };

  // Expansion feeds check exactly like written annotations.
  const r1 = p2("ext/ @strict @pkg\n  ok.json");
  ap(r1, profiles);
  const io = {
    kind: (q: string) => (q.includes(".") ? ("file" as const) : ("dir" as const)),
    readdir: () => ["ok.json", "dist", "rogue.ts"],
    countLines: () => 200,
    fileSize: () => 0,
  };
  const v1 = runCheck(r1.root, io);
  const kinds = Object.fromEntries(v1.map((v) => [v.path, v.kind]));
  assert.equal(kinds["ext/dist"], undefined); // allowed via profile
  assert.equal(kinds["ext/rogue.ts"], "strict-extra");
  assert.equal(kinds["ext/ok.json"], "max-lines"); // folder default via profile

  // Explicit annotation wins over the profile, with an info diagnostic.
  const r2 = p2("ext/ @strict @pkg @max-lines(500)\n  ok.json");
  ap(r2, profiles);
  assert.ok(r2.diagnostics.some((d) => d.severity === "info" && /overrides/.test(d.message)));
  assert.equal(runCheck(r2.root, io).filter((v) => v.kind === "max-lines").length, 0);

  // Two profiles disagreeing on a key is an error and excludes the entry.
  const r3 = p2("ext/ @pkg @tiny\n");
  ap(r3, profiles);
  assert.equal(r3.stats.errors, 1);
  assert.ok(r3.diagnostics.some((d) => /disagree on @max-lines/.test(d.message)));

  // fmt never emits injected annotations.
  const r4src = "ext/ @strict @pkg\n";
  assert.equal(format(r4src), r4src);
});

test("case-collision siblings warn", () => {
  const { diagnostics } = parse("Readme.md\nreadme.md\nother.md");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /differs only by letter case/);
  assert.equal(diagnostics[0].severity, "warning");
});

test("@forbidden fails when present, apply never creates it", () => {
  const { root, diagnostics } = parse("src/\n  utils/ @forbidden\n  main.ts");
  assert.equal(diagnostics.length, 0);
  const io = {
    kind: (p: string) => (p === "src/utils" ? ("dir" as const) : p.includes(".") ? ("file" as const) : ("dir" as const)),
    readdir: () => [],
    countLines: () => 0,
    fileSize: () => 0,
  };
  const violations = runCheck(root, io);
  assert.deepEqual(violations.map((v) => [v.kind, v.path]), [["forbidden", "src/utils"]]);

  // Once removed from disk, the contract conforms.
  const ioGone = { ...io, kind: (p: string) => (p === "src/utils" ? ("missing" as const) : io.kind(p)) };
  assert.equal(runCheck(root, ioGone).length, 0);

  // The plan must never create a forbidden entry.
  assert.ok(!plan(root).some((op) => op.path.includes("utils")));
});

test("@count bounds a folder's direct entries", () => {
  const { root } = parse("scripts/ @count(2)");
  const io = {
    kind: () => "dir" as const,
    readdir: () => ["a.sh", "b.sh", "c.sh"],
    countLines: () => 0,
    fileSize: () => 0,
  };
  const violations = runCheck(root, io);
  assert.deepEqual(violations.map((v) => v.kind), ["count"]);
  assert.match(violations[0].message, /3 direct entries, exceeds @count\(2\)/);
});

test("runCheck with injected IO reports all violation kinds", () => {
  const { root } = parse(
    ["app/ @strict", "  main.ts @max-lines(2)", "  gone.ts", "  maybe.ts @optional"].join("\n")
  );
  const world: Record<string, "file" | "dir"> = {
    app: "dir",
    "app/main.ts": "file",
    "app/sprawl.ts": "file",
  };
  const violations = runCheck(root, {
    kind: (p) => world[p] ?? "missing",
    readdir: (p) =>
      Object.keys(world)
        .filter((k) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/"))
        .map((k) => k.slice(p.length + 1)),
    countLines: () => 5,
    fileSize: () => 0,
  });
  assert.deepEqual(
    violations.map((v) => [v.kind, v.path]).sort(),
    [
      ["max-lines", "app/main.ts"],
      ["missing", "app/gone.ts"],
      ["strict-extra", "app/sprawl.ts"],
    ].sort()
  );
  // strict-extra anchors to the @strict folder's node; @optional absence is silent
  const extra = violations.find((v) => v.kind === "strict-extra")!;
  assert.equal(extra.node.name, "app");
});

test("declared vocabulary value shapes are validated", () => {
  const r = parse("a.ts @jira\nb.ts @jira(ABC-1)\nc.ts @gen(now)\nd.ts @count(x)");
  validateVocabulary(r, {
    jira: { value: "string" },
    gen: { value: "flag" },
    count: { value: "number" },
  });
  const warnings = r.diagnostics.filter((d) => d.severity === "warning");
  assert.deepEqual(
    warnings.map((w) => w.message).sort(),
    ["@count requires a numeric value.", "@gen takes no value.", "@jira requires a value."].sort()
  );
  assert.equal(r.stats.warnings, 3);
});

test("fmt --align pads annotated lines to a shared column", () => {
  const src = "core/ @strict\nlanguage-server/ @strict\nplain.txt\n";
  const aligned = format(src, { align: true });
  assert.equal(
    aligned,
    "core/            @strict\nlanguage-server/ @strict\nplain.txt\n"
  );
  // Idempotent in aligned mode, and canonical mode collapses it back.
  assert.equal(format(aligned, { align: true }), aligned);
  assert.equal(format(aligned), src);
});

test("accept declares extras, prunes only with the flag", () => {
  const src = "app/ @strict @max-lines(5)\n  keep.ts\n  gone/ # dead subtree\n    old.ts\n";
  const result = parse(src);
  const world: Record<string, "file" | "dir"> = {
    app: "dir",
    "app/keep.ts": "file",
    "app/new.ts": "file",
    "app/vendor": "dir",
  };
  const io = {
    kind: (p: string) => world[p] ?? ("missing" as const),
    readdir: (p: string) =>
      Object.keys(world)
        .filter((k) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/"))
        .map((k) => k.slice(p.length + 1)),
    countLines: () => 99, // keep.ts and new.ts both violate the metric
    fileSize: () => 0,
  };
  const violations = runCheck(result.root, io);

  // Default: additions only. Missing stays untouched, metrics stay decisions.
  const soft = acceptViolations(src, result, violations);
  assert.deepEqual(soft.declared.sort(), ["app/new.ts", "app/vendor/"]);
  assert.deepEqual(soft.removed, []);
  assert.ok(soft.text.includes("  gone/ # dead subtree"));
  assert.ok(soft.remaining.some((v) => v.kind === "max-lines"));

  // Prune removes the missing entry and its whole subtree.
  const hard = acceptViolations(src, result, violations, { prune: true });
  assert.deepEqual(hard.removed, ["app/gone"]);
  assert.ok(!hard.text.includes("gone/"));
  assert.ok(!hard.text.includes("old.ts"));

  // The amended draft parses and now declares the reality it admitted.
  const reparsed = parse(hard.text);
  assert.equal(reparsed.stats.errors, 0);
  const names = reparsed.root.children[0].children.map((c) => c.name).sort();
  assert.deepEqual(names, ["keep.ts", "new.ts", "vendor"]);

  // Accepting again changes nothing: the loop converges.
  const again = acceptViolations(hard.text, reparsed, runCheck(reparsed.root, io), { prune: true });
  assert.equal(again.text, hard.text);
});

test("empty document parses to an empty tree", () => {
  const { root, stats } = parse("");
  assert.equal(root.children.length, 0);
  assert.equal(stats.errors, 0);
});
