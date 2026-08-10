import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, plan, toScript, format, quoteName, runCheck, validateVocabulary, acceptViolations } from "../dist/index.js";

const msgs = (src: string) => parse(src).diagnostics.map((d) => d.message).join("\n");

const worldIO = (world: Record<string, { kind: "file" | "dir"; lines?: number; size?: number }>) => ({
  kind: (p: string) => world[p]?.kind ?? ("missing" as const),
  readdir: (p: string) =>
    Object.keys(world).filter((k) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/")).map((k) => k.slice(p.length + 1)),
  countLines: (p: string) => world[p]?.lines ?? 0,
  fileSize: (p: string) => world[p]?.size ?? 0,
});

test("basic nesting, trailing slash, comments and blanks", () => {
  const { root, stats, diagnostics } = parse(
    ["# a comment", "", "app/", "  src/", "    # nested comment", "    main.cpp", "  README.md"].join("\n")
  );
  assert.equal(diagnostics.length, 0);
  assert.equal(stats.folders, 2);
  assert.equal(stats.files, 2);
  const app = root.children[0];
  assert.equal(app.name, "app");
  assert.ok(app.isFolder);
  const [src, readme] = app.children;
  assert.equal(src.children[0].name, "main.cpp");
  assert.equal(readme.name, "README.md");

  const { root: r2 } = parse("bin/\nbin");
  assert.ok(r2.children[0].isFolder);
  assert.ok(!r2.children[1].isFolder);
});

test("over-indentation is clamped, children of files are errors", () => {
  const deep = parse("app/\n  b/\n      too-deep.txt");
  assert.equal(deep.diagnostics.length, 1);
  assert.equal(deep.diagnostics[0].severity, "error");
  assert.equal(deep.root.children[0].children[0].children[0].name, "too-deep.txt");

  const kids = parse("notes.txt\n  child.txt");
  assert.equal(kids.diagnostics.length, 1);
  assert.match(kids.diagnostics[0].message, /Files cannot contain children/);
});

test("forbidden characters and dot names are flagged", () => {
  const bad = parse("bad:name.txt");
  assert.equal(bad.diagnostics.length, 1);
  assert.match(bad.diagnostics[0].message, /not allowed/);

  const dots = parse("../\n./\n..");
  const errors = dots.diagnostics.filter((d) => d.severity === "error");
  assert.equal(errors.length, 3); // a 4th diagnostic is the duplicate-name warning
  assert.ok(errors.every((d) => /not a valid name/.test(d.message)));
});

test("duplicate and case-collision siblings warn but stay in the tree", () => {
  const dup = parse("a.txt\na.txt");
  assert.equal(dup.diagnostics.length, 1);
  assert.equal(dup.diagnostics[0].severity, "warning");
  assert.equal(dup.root.children.length, 2);

  const twin = parse("Readme.md\nreadme.md\nother.md");
  assert.equal(twin.diagnostics.length, 1);
  assert.match(twin.diagnostics[0].message, /differs only by letter case/);
});

test("indent unit is inferred, odd indentation warns and rounds down", () => {
  const odd = parse("app/\n  two/\n   three.txt");
  assert.equal(odd.diagnostics.length, 1);
  assert.equal(odd.diagnostics[0].severity, "warning");
  assert.match(odd.diagnostics[0].message, /multiple of 2/);
  assert.equal(odd.root.children[0].children[1].name, "three.txt"); // rounds to depth 1

  const four = parse("app/\n    src/\n        main.ts");
  assert.equal(four.diagnostics.length, 0);
  assert.equal(four.indentUnit, 4);
  assert.equal(four.root.children[0].children[0].children[0].name, "main.ts");

  const tabs = parse("app/\n\tsrc/\n\t\tmain.ts");
  assert.equal(tabs.diagnostics.length, 0);
  assert.equal(tabs.root.children[0].children[0].children[0].name, "main.ts");

  const mixed = parse("app/\n \tx.txt");
  assert.equal(mixed.diagnostics.length, 1);
  assert.match(mixed.diagnostics[0].message, /Mixed tabs and spaces/);
});

test("interior @ and # without whitespace are ordinary name characters", () => {
  const { root, diagnostics } = parse(
    ["@types/", "  file@2x.png", "  notes#1.md? # trailing comment"].join("\n")
  );
  assert.equal(diagnostics.length, 0);
  const scoped = root.children[0];
  assert.equal(scoped.name, "@types");
  assert.equal(scoped.children[0].name, "file@2x.png");
  assert.equal(scoped.children[1].name, "notes#1.md");
  assert.deepEqual(scoped.children[1].annotations.map((a) => a.key), ["optional"]);
});

test("quoted names carry syntax characters literally", () => {
  const { root, diagnostics } = parse(
    ['"release @ 2x"/', '  "notes #draft.md"?', '  "#hash first.txt"'].join("\n")
  );
  assert.equal(diagnostics.length, 0);
  const folder = root.children[0];
  assert.equal(folder.name, "release @ 2x");
  assert.ok(folder.isFolder);
  assert.equal(folder.children[0].name, "notes #draft.md");
  assert.deepEqual(folder.children[0].annotations.map((a) => a.key), ["optional"]);
  assert.equal(folder.children[1].name, "#hash first.txt");

  // Quoting is for syntax collisions. Forbidden path chars stay forbidden.
  const bad = parse('"say \\"hi\\".txt"');
  assert.equal(bad.diagnostics.length, 1);
  assert.match(bad.diagnostics[0].message, /not allowed/);

  const open = parse('"broken.txt');
  assert.equal(open.diagnostics.length, 1);
  assert.match(open.diagnostics[0].message, /Unterminated/);
  assert.equal(open.lines[0].kind, "file");
});

test("the ? sigil marks entries optional", () => {
  const r = parse(["test.dft?", "vendor/?", '"my vendor"/?'].join("\n"));
  assert.equal(r.diagnostics.length, 0);
  for (const line of r.lines) {
    assert.deepEqual(line.annotations.map((a) => [a.key, a.value]), [["optional", null]]);
  }
  assert.ok(r.lines[1].isFolder);
  assert.ok(r.lines[2].isFolder);
  assert.equal(r.lines[2].name, "my vendor");
});

test("attribute containers: flags, single values, lists, trailing commas", () => {
  const { lines, diagnostics } = parse("a/ { flag, count: 6, allow: [x, y], empty: [], owner: @core, }");
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(
    lines[0].annotations.map((a) => [a.key, a.value, a.values]),
    [["flag", null, []], ["count", "6", ["6"]], ["allow", "x, y", ["x", "y"]], ["empty", "", []], ["owner", "@core", ["@core"]]]
  );
  assert.equal(parse("a.txt { }").diagnostics.length, 0);

  const quoted = parse('a.txt { template: "weird (name)", note: "say \\"hi\\"" }');
  assert.deepEqual(quoted.lines[0].annotations.map((a) => a.value), ["weird (name)", 'say "hi"']);
});

test("duplicate keys and forbidden-plus-optional are entry-level errors", () => {
  const { diagnostics } = parse("a.ts { max-lines: 10, max-lines: 20 }");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "error");
  assert.match(diagnostics[0].message, /Duplicate “max-lines”/);
  assert.match(diagnostics[0].message, /Values never combine/);
  assert.match(msgs("shared/? { forbidden }"), /replaces presence rules/);
  assert.match(msgs("shared/ { forbidden, optional }"), /replaces presence rules/);
});

test("bare trailing @word draws the migration error, quoting is the escape", () => {
  const r = parse("src/ @strict");
  assert.equal(r.stats.errors, 1);
  assert.match(r.diagnostics[0].message, /pre-release syntax/);
  const quoted = parse('"src @strict"');
  assert.equal(quoted.stats.errors, 0);
  assert.equal(quoted.lines[0].name, "src @strict");
});

test("path lines create implicit folders and carry attributes on the leaf", () => {
  const { root, lines, diagnostics, stats } = parse("src/legacy/db.ts { max-lines: 900 }");
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(lines[0].path, ["src", "legacy", "db.ts"]);
  assert.equal(lines[0].name, "db.ts");
  const db = root.children[0].children[0].children[0];
  assert.equal(db.name, "db.ts");
  assert.deepEqual(db.annotations.map((a) => [a.key, a.value]), [["max-lines", "900"]]);
  assert.deepEqual(plan(root).map((o) => [o.type, o.path]), [["mkdir", "src/"], ["mkdir", "src/legacy/"], ["touch", "src/legacy/db.ts"]]);
  assert.equal(stats.files, 1); // implicit folders are not declared entries
});

test("path segments merge into declared folders, never through files", () => {
  const m = parse("src/ { strict }\nsrc/util/helper.ts");
  assert.equal(m.diagnostics.length, 0);
  assert.equal(m.root.children.length, 1);
  assert.equal(m.root.children[0].children[0].name, "util");

  assert.match(msgs("src\nsrc/x.ts"), /already declared as a file/);
  assert.match(msgs('"a/b"'), /single segment/);
  assert.match(msgs("a//b"), /Empty path segment/);

  // A trailing slash makes the leaf a folder that can take children.
  const leaf = parse("a/b/\n  c.txt");
  assert.equal(leaf.diagnostics.length, 0);
  assert.ok(leaf.root.children[0].children[0].isFolder);
  assert.equal(leaf.root.children[0].children[0].children[0].name, "c.txt");
});

test("expanded containers: one item per line, comma items, comments, closer", () => {
  const src = [
    "ext/ { # policy",
    "  strict, count: 3",
    "  # interior comment",
    "  allow: [dist/, *.vsix]",
    "}",
    "  inner.txt",
  ].join("\n");
  const { root, lines, diagnostics } = parse(src);
  assert.equal(diagnostics.length, 0);
  assert.equal(lines[0].opensBlock, true);
  assert.equal(lines[1].kind, "annotation");
  assert.equal(lines[2].kind, "comment");
  assert.equal(lines[4].kind, "block-end");
  const ext = root.children[0];
  assert.deepEqual(ext.annotations.map((a) => a.key), ["strict", "count", "allow"]);
  assert.equal(ext.children[0].name, "inner.txt"); // entries resume after }
});

test("container brace errors: unclosed, junk after closer, unmatched", () => {
  const inline = parse("a.txt { strict\nb.txt");
  assert.ok(inline.diagnostics.some((d) => /Unclosed/.test(d.message)));
  assert.ok(!inline.lines[0].opensBlock); // items with no } never open a block
  assert.equal(inline.lines[1].kind, "file");

  assert.match(msgs("ext/ {\n  strict"), /Unclosed/);
  assert.match(msgs("ext/ {\n  strict\n} tail"), /alone on its line/);
  assert.match(msgs("a.txt\n}"), /Unmatched/);
  assert.match(msgs("a/ { strict # dangling"), /before the # comment/);
});

test("malformed items report and resync without eating the line", () => {
  assert.match(msgs("a/ { allow: [dist/ }"), /Unclosed “\[” list/);
  assert.match(msgs("a/ { allow: [a, [b]] }"), /Lists do not nest/);
  assert.match(msgs("a/ { count: }"), /Missing value after/);
  assert.match(msgs("a/ { strict count: 2 }"), /Expected “:” after “strict”/);

  // Resync at the comma: later items on the same line still parse.
  const junk = parse("a/ { allow: [x] junk, count: 2 }");
  assert.equal(junk.diagnostics.length, 1);
  assert.match(junk.diagnostics[0].message, /Expected “,”, “}”, or a # comment/);
  assert.deepEqual(junk.lines[0].annotations.map((a) => [a.key, a.value]), [["allow", "x"], ["count", "2"]]);
  const garbage = parse("a/ { %% , strict }");
  assert.match(garbage.diagnostics[0].message, /Expected an attribute/);
  assert.deepEqual(garbage.lines[0].annotations.map((a) => a.key), ["strict"]);
});

test("error lines are excluded from plan and left verbatim by fmt", () => {
  const src = "ok/\n  bad:file.txt\n  good.txt\nx/ { count: }\n";
  const { root } = parse(src);
  assert.deepEqual(plan(root).map((o) => o.path), ["ok/", "ok/good.txt"]);
  const out = format(src);
  assert.ok(out.includes("  bad:file.txt"));
  assert.ok(out.includes("x/ { count: }"));
});

test("preset definitions: duplicates, banned keys, bad references", () => {
  assert.match(msgs("preset a { x: 1 }\npreset a { y: 2 }"), /defined twice/);
  assert.match(msgs("preset bad { strict }"), /cannot live in a preset/);
  assert.match(msgs("preset a"), /container/);
  assert.match(msgs("x/ { preset: nope }"), /Unknown preset/);
  assert.match(msgs("preset a { x: 1 }\npreset b { y: 2 }\nz/ { preset: [a, b] }"), /never compose/);

  // Banned keys are reported and excluded from the expansion.
  const bad = parse("preset bad { strict, allow: [x] }");
  assert.deepEqual(bad.presets.bad, { expands: { allow: ["x"] } });

  // Indented preset-shaped lines are ordinary entries.
  const entry = parse("app/\n  preset x { count: 1 }");
  assert.equal(entry.lines[1].kind, "file");
  assert.equal(entry.lines[1].name, "preset x");
});

test("preset expansion: fromProfile marks injected, explicit wins with info", () => {
  const r = parse("preset pkg { max-lines: 100 }\next/ { preset: pkg, max-lines: 500 }");
  assert.equal(r.stats.errors, 0);
  assert.ok(r.diagnostics.some((d) => d.severity === "info" && /overrides/.test(d.message)));
  const ext = r.root.children[0];
  assert.deepEqual(
    ext.annotations.filter((a) => a.key === "max-lines").map((a) => [a.value, a.fromProfile]),
    [["500", undefined]]
  );

  // fmt never emits injected annotations.
  const canonical = "preset pkg { allow: [dist/, tmp/] }\next/ { strict, preset: pkg }\n";
  assert.equal(format(canonical), canonical);
});

test("in-draft presets feed check exactly like written attributes", () => {
  const r = parse("preset pkg { allow: [dist/], max-lines: 100 }\next/ { strict, preset: pkg }\n  ok.json");
  assert.equal(r.diagnostics.length, 0);
  const io = worldIO({
    ext: { kind: "dir" }, "ext/ok.json": { kind: "file", lines: 200 }, "ext/dist": { kind: "dir" }, "ext/rogue.ts": { kind: "file", lines: 1 },
  });
  const kinds = Object.fromEntries(runCheck(r.root, io).map((v) => [v.path, v.kind]));
  assert.equal(kinds["ext/dist"], undefined); // allowed via the preset
  assert.equal(kinds["ext/rogue.ts"], "strict-extra");
  assert.equal(kinds["ext/ok.json"], "max-lines"); // folder default via the preset
});

test("the whole surface at once: parse, presets, format round-trip", () => {
  const smoke = [
    "drafteine 1",
    "",
    "preset pkg { allow: [dist/, node_modules/] }",
    "",
    "packages/ { owner: @core, strict, count: 6 } # comment",
    "  core/ { strict, preset: pkg }",
    "    apply.ts { since: 0.8.0 }",
    "  shared/ { forbidden }",
    "  test.dft?",
    "src/legacy/db.ts { max-lines: 900 }",
    "ext/ { # expanded",
    "  strict",
    "  allow: [dist/, *.vsix]",
    "}",
    "  inner.txt",
  ].join("\n") + "\n";
  const r = parse(smoke);
  assert.equal(r.diagnostics.length, 0);
  assert.deepEqual(r.stats, { folders: 4, files: 4, errors: 0, warnings: 0 });
  assert.deepEqual(r.presets, { pkg: { expands: { allow: ["dist/", "node_modules/"] } } });

  const packages = r.root.children[0];
  assert.equal(packages.annotations.find((a) => a.key === "owner")!.value, "@core");
  const core = packages.children[0];
  assert.deepEqual(
    core.annotations.map((a) => [a.key, a.value, a.fromProfile]),
    [["strict", null, undefined], ["preset", "pkg", undefined], ["allow", "dist/, node_modules/", "pkg"]]
  );
  assert.equal(core.children[0].annotations[0].value, "0.8.0");
  assert.deepEqual(packages.children[2].annotations.map((a) => a.key), ["optional"]);

  const db = r.root.children[1].children[0].children[0];
  assert.deepEqual([db.name, db.annotations[0].value], ["db.ts", "900"]);
  const ext = r.root.children[2];
  assert.deepEqual(ext.annotations.map((a) => a.key), ["strict", "allow"]);
  assert.equal(ext.children[0].name, "inner.txt");

  const out = format(smoke);
  assert.equal(out, smoke); // byte-identical round-trip
  assert.equal(format(out), out);
});

test("folder metric defaults inherit, file attributes override", () => {
  const { root, diagnostics } = parse(
    ["src/ { max-lines: 10 }", "  big.ts", "  exempt.ts { max-lines: 100 }", "  nested/ { max-lines: 50 }", "    mid.ts"].join("\n")
  );
  assert.equal(diagnostics.length, 0);
  const io = worldIO({
    src: { kind: "dir" }, "src/big.ts": { kind: "file", lines: 30 }, "src/exempt.ts": { kind: "file", lines: 30 },
    "src/nested": { kind: "dir" }, "src/nested/mid.ts": { kind: "file", lines: 30 },
  });
  const violations = runCheck(root, io);
  // big.ts inherits 10 and fails at 30. exempt.ts overrides to 100 and
  // passes. mid.ts inherits the nearer nested/ default of 50 and passes.
  assert.deepEqual(violations.map((v) => v.path), ["src/big.ts"]);
  assert.match(violations[0].message, /30 lines, exceeds max-lines: 10/);
});

test("max-size checks bytes with k and m suffixes", () => {
  const { root } = parse("assets/ { max-size: 1k }\n  logo.png\n  video.mp4 { max-size: 2m }");
  const io = worldIO({
    assets: { kind: "dir" }, "assets/logo.png": { kind: "file", size: 5000 }, "assets/video.mp4": { kind: "file", size: 1500000 },
  });
  const violations = runCheck(root, io);
  assert.deepEqual(violations.map((v) => [v.kind, v.path]), [["max-size", "assets/logo.png"]]);
  assert.match(violations[0].message, /exceeds max-size: 1k/);
});

test("allow tolerates matching extras in strict folders", () => {
  const { root, diagnostics } = parse(
    "ext/ { strict, allow: [*.vsix, dist/, node_modules/], max-lines: 10 }\n  package.json"
  );
  assert.equal(diagnostics.length, 0);
  const io = worldIO({
    ext: { kind: "dir" }, "ext/package.json": { kind: "file", lines: 3 },
    "ext/drafteine-0.4.0.vsix": { kind: "file", lines: 99 }, "ext/big.vsix": { kind: "file", lines: 50 },
    "ext/dist": { kind: "dir" }, "ext/dist.txt": { kind: "file", lines: 1 }, // dist/ is dirs only
    "ext/rogue.ts": { kind: "file", lines: 1 },
  });
  const violations = runCheck(root, io);
  const byPath = Object.fromEntries(violations.map((v) => [v.path, v.kind]));
  // rogue.ts and dist.txt are not allowed. The vsix files are tolerated,
  // but tolerated file extras still honor the folder's max-lines default.
  assert.equal(byPath["ext/rogue.ts"], "strict-extra");
  assert.equal(byPath["ext/dist.txt"], "strict-extra");
  assert.equal(byPath["ext/drafteine-0.4.0.vsix"], "max-lines");
  assert.equal(byPath["ext/big.vsix"], "max-lines");
  assert.equal(byPath["ext/dist"], undefined);
  assert.equal(violations.length, 4);
  assert.match(violations.find((v) => v.path === "ext/rogue.ts")!.message, /undeclared direct child of strict folder ext\//);
});

test("forbidden fails when present, apply never creates it", () => {
  const { root, diagnostics } = parse("src/\n  utils/ { forbidden }\n  main.ts");
  assert.equal(diagnostics.length, 0);
  const io = worldIO({ src: { kind: "dir" }, "src/utils": { kind: "dir" }, "src/main.ts": { kind: "file" } });
  const violations = runCheck(root, io);
  assert.deepEqual(violations.map((v) => [v.kind, v.path]), [["forbidden", "src/utils"]]);
  assert.match(violations[0].message, /declared forbidden/);

  // Once removed from disk, the contract conforms.
  const gone = worldIO({ src: { kind: "dir" }, "src/main.ts": { kind: "file" } });
  assert.equal(runCheck(root, gone).length, 0);

  // The plan must never create a forbidden entry.
  assert.ok(!plan(root).some((op) => op.path.includes("utils")));
});

test("count bounds a folder's direct entries", () => {
  const { root } = parse("scripts/ { count: 2 }");
  const io = worldIO({
    scripts: { kind: "dir" }, "scripts/a.sh": { kind: "file" }, "scripts/b.sh": { kind: "file" }, "scripts/c.sh": { kind: "file" },
  });
  const violations = runCheck(root, io);
  assert.deepEqual(violations.map((v) => v.kind), ["count"]);
  assert.match(violations[0].message, /3 direct entries, exceeds count: 2/);
});

test("runCheck with injected IO reports all violation kinds", () => {
  const { root } = parse(
    ["app/ { strict }", "  main.ts { max-lines: 2 }", "  gone.ts", "  maybe.ts?", "  sub/"].join("\n")
  );
  const io = worldIO({
    app: { kind: "dir" }, "app/main.ts": { kind: "file", lines: 5 }, "app/sprawl.ts": { kind: "file", lines: 5 }, "app/sub": { kind: "file" },
  });
  const violations = runCheck(root, io);
  assert.deepEqual(
    violations.map((v) => [v.kind, v.path]).sort(),
    [
      ["max-lines", "app/main.ts"],
      ["missing", "app/gone.ts"],
      ["strict-extra", "app/sprawl.ts"],
      ["type-mismatch", "app/sub"],
    ].sort()
  );
  // strict-extra anchors to the strict folder's node. Optional absence is silent.
  assert.equal(violations.find((v) => v.kind === "strict-extra")!.node.name, "app");
});

test("declared vocabulary value shapes are validated", () => {
  const r = parse("a.ts { jira }\nb.ts { jira: ABC-1 }\nc.ts { gen: now }\nd.ts { count: x }");
  validateVocabulary(r, { jira: { value: "string" }, gen: { value: "flag" }, count: { value: "number" } });
  const warnings = r.diagnostics.filter((d) => d.severity === "warning");
  assert.deepEqual(
    warnings.map((w) => w.message).sort(),
    ["“count” requires a numeric value.", "“gen” takes no value.", "“jira” requires a value."].sort()
  );
  assert.equal(r.stats.warnings, 3);
});

test("plan skips error lines and orders depth-first", () => {
  const source = ["app/", "  src/", "    main.cpp { template: cpp-main }", "  bad:file", "docs/"].join("\n");
  const { root } = parse(source);
  const ops = plan(root);
  assert.deepEqual(
    ops.map((o) => [o.type, o.path]),
    [["mkdir", "app/"], ["mkdir", "app/src/"], ["touch", "app/src/main.cpp"], ["mkdir", "docs/"]]
  );
  assert.equal(ops[2].template, "cpp-main");

  // Script output quotes paths that need it.
  const script = toScript(plan(parse("my docs/\n  a file.txt").root));
  assert.match(script, /mkdir -p 'my docs'/);
  assert.match(script, /touch 'my docs\/a file\.txt'/);
});

test("needsQuoting drives quoteName: syntax collisions only", () => {
  assert.equal(quoteName("plain.txt"), "plain.txt");
  assert.equal(quoteName("file@2x.png"), "file@2x.png");
  assert.equal(quoteName("notes#1.md"), "notes#1.md");
  assert.equal(quoteName("has @sign.txt"), '"has @sign.txt"');
  assert.equal(quoteName("has #tag.txt"), '"has #tag.txt"');
  assert.equal(quoteName("open {brace"), '"open {brace"');
  assert.equal(quoteName("a/b"), '"a/b"');
  assert.equal(quoteName("#lead"), '"#lead"');
  assert.equal(quoteName(" pad"), '" pad"');
  assert.equal(quoteName("pad "), '"pad "');
  assert.equal(quoteName("preset x"), '"preset x"');
  assert.equal(quoteName(""), '""');
});

test("format canonicalizes and is idempotent", () => {
  const messy = [
    "app/   {  strict }",
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
    ["app/ { strict }", "", "  src/", "    main.ts", "  three.txt", "  README.md # keep docs"].join("\n") + "\n"
  );
});

test("format prefers the ? sigil over the optional word", () => {
  assert.equal(format("a.txt { optional }\n"), "a.txt?\n");
  assert.equal(format("vendor/ { optional }\n"), "vendor/?\n");
  assert.equal(format("vendor/?\n"), "vendor/?\n");
  // The sigil survives next to other attributes.
  assert.equal(format("a.txt { optional, max-lines: 5 }\n"), "a.txt? { max-lines: 5 }\n");
});

test("list values round-trip, quotes drop where they can", () => {
  const src = 'ext/ { strict, allow: [ *.vsix ,dist/ , "with, comma" ] }\n';
  const { lines, diagnostics } = parse(src);
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(lines[0].annotations.find((a) => a.key === "allow")!.values, ["*.vsix", "dist/", "with, comma"]);
  const out = format(src);
  assert.equal(out, 'ext/ { strict, allow: [*.vsix, dist/, "with, comma"] }\n');
  assert.equal(out, format(out));
});

test("format expands containers past 80 columns and keeps expanded form", () => {
  const long =
    "averyveryverylongfolder-name-here/ { owner: @platform-team, allow: [dist/, coverage/, node_modules/] }\n";
  assert.equal(
    format(long),
    ["averyveryverylongfolder-name-here/ {", "  owner: @platform-team", "  allow: [dist/, coverage/, node_modules/]", "}"].join("\n") + "\n"
  );
  // An author-expanded block stays expanded even when it would fit inline.
  const expanded = "ext/ {\n  strict\n  count: 3\n}\n";
  assert.equal(format(expanded), expanded);
});

test("fmt --align pads containers to a shared column", () => {
  const src = "core/ { strict }\nlanguage-server/ { strict }\nplain.txt\n";
  const aligned = format(src, { align: true });
  assert.equal(aligned, "core/            { strict }\nlanguage-server/ { strict }\nplain.txt\n");
  // Idempotent in aligned mode, and canonical mode collapses it back.
  assert.equal(format(aligned, { align: true }), aligned);
  assert.equal(format(aligned), src);
});

test("format leaves error lines verbatim and quotes when needed", () => {
  const src = 'ok.txt\nbad:name.txt\n"needs @quote.txt"\n"a b.txt"\n';
  const out = format(src);
  assert.match(out, /^ok\.txt\n/);
  assert.match(out, /bad:name\.txt/); // untouched despite error
  assert.match(out, /"needs @quote\.txt"/); // stays quoted, it must
  assert.match(out, /\na b\.txt\n/); // needless quotes drop
});

test("accept declares extras, prunes only with the flag", () => {
  const src = "app/ { strict, max-lines: 5 }\n  keep.ts\n  gone/ # dead subtree\n    old.ts\n";
  const result = parse(src);
  const io = worldIO({
    app: { kind: "dir" }, "app/keep.ts": { kind: "file", lines: 99 }, "app/new.ts": { kind: "file", lines: 99 }, "app/vendor": { kind: "dir" },
  });
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
  assert.deepEqual(reparsed.root.children[0].children.map((c) => c.name).sort(), ["keep.ts", "new.ts", "vendor"]);

  // Accepting again changes nothing: the loop converges.
  const again = acceptViolations(hard.text, reparsed, runCheck(reparsed.root, io), { prune: true });
  assert.equal(again.text, hard.text);
});

test("empty document parses to an empty tree", () => {
  const { root, stats } = parse("");
  assert.equal(root.children.length, 0);
  assert.equal(stats.errors, 0);
});

test("version pragma parses on the first content line", () => {
  const res = parse("drafteine 1\n\nsrc/\n  main.ts\n");
  assert.equal(res.version, 1);
  assert.equal(res.lines[0].kind, "pragma");
  assert.equal(res.stats.files, 1);
  assert.equal(res.stats.errors, 0);
  assert.equal(res.stats.warnings, 0);
  // Header comments and blanks may precede the pragma.
  assert.equal(parse("# contract\ndrafteine 1\nsrc/\n").version, 1);
  // A BOM on line one is tolerated.
  assert.equal(parse("﻿drafteine 1\nsrc/\n").version, 1);
  // Absence means format 1, permanently.
  assert.equal(parse("src/\n").version, 1);
});

test("newer declared format warns and still parses best-effort", () => {
  const res = parse("drafteine 3 # future\nsrc/\n  main.ts\n");
  assert.equal(res.version, 3);
  assert.equal(res.stats.warnings, 1);
  assert.equal(res.stats.errors, 0);
  assert.equal(res.stats.files, 1);
  // Trailing text after a newer version may be meaningful in that format:
  // tolerated, covered by the newer-format warning alone.
  const loose = parse("drafteine 2 beta\nsrc/\n");
  assert.equal(loose.version, 2);
  assert.equal(loose.stats.errors, 0);
  assert.equal(loose.stats.warnings, 1);
});

test("malformed pragma diagnoses instead of becoming a file", () => {
  for (const bad of ["drafteine 1.0\n", "drafteine 01\n", "drafteine 1 beta\n"]) {
    const res = parse(bad + "src/\n");
    assert.equal(res.lines[0].kind, "pragma", bad);
    assert.ok(res.stats.errors > 0, bad);
    assert.equal(res.stats.files, 0, bad);
    assert.equal(res.version, 1, bad);
  }
  // A wordy name is not a pragma attempt.
  const wordy = parse("drafteine notes.txt\n");
  assert.equal(wordy.lines[0].kind, "file");
  assert.equal(wordy.stats.errors, 0);
});

test("pragma-shaped line after content warns and parses as a file", () => {
  const res = parse("src/\ndrafteine 2\n");
  assert.equal(res.lines[1].kind, "file");
  assert.equal(res.lines[1].name, "drafteine 2");
  assert.equal(res.version, 1);
  assert.equal(res.stats.warnings, 1);
});

test("a file genuinely named like a pragma quotes and round-trips", () => {
  const res = parse('"drafteine 1"\n');
  assert.equal(res.lines[0].kind, "file");
  assert.equal(res.lines[0].name, "drafteine 1");
  assert.equal(res.stats.warnings, 0);
  assert.equal(quoteName("drafteine 1"), '"drafteine 1"');
  assert.equal(format('"drafteine 1"\n'), '"drafteine 1"\n');
});

test("fmt canonicalizes the pragma and refuses newer formats", () => {
  assert.equal(format("drafteine   1   # keep this\nsrc/\n"), "drafteine 1 # keep this\nsrc/\n");
  const newer = "drafteine 9\nsrc/   \n";
  assert.equal(format(newer), newer); // returned unchanged, the no-rewrite rule
});
