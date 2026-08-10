import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bin = new URL("../dist/drafteine.js", import.meta.url).pathname;

function run(cmdArgs: string[]): string {
  return execFileSync(process.execPath, [bin, ...cmdArgs], {
    encoding: "utf8",
  });
}

function tmpSetup(source: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drafteine-"));
  const file = path.join(dir, "draft.dft");
  fs.writeFileSync(file, source);
  return { dir, file };
}

test("apply creates the drafted structure and is idempotent", () => {
  const { dir, file } = tmpSetup("app/\n  src/\n    main.js\n  README.md\n");
  run(["apply", file, "--root", dir]);
  assert.ok(fs.statSync(path.join(dir, "app/src")).isDirectory());
  assert.ok(fs.statSync(path.join(dir, "app/src/main.js")).isFile());
  assert.ok(fs.statSync(path.join(dir, "app/README.md")).isFile());

  fs.writeFileSync(path.join(dir, "app/README.md"), "precious content");
  const second = run(["apply", file, "--root", dir]);
  assert.match(second, /skipped 4 existing/);
  assert.equal(
    fs.readFileSync(path.join(dir, "app/README.md"), "utf8"),
    "precious content"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("plan is read-only and dry-run creates nothing", () => {
  const { dir, file } = tmpSetup("app/\n  main.js\n");
  run(["plan", file, "--root", dir]);
  run(["apply", file, "--root", dir, "--dry-run"]);
  assert.ok(!fs.existsSync(path.join(dir, "app")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("error lines are excluded and exit code is 1", () => {
  const { dir, file } = tmpSetup("app/\n  ok.js\n  bad:name.js\n");
  let status = 0;
  let out = "";
  try {
    out = run(["apply", file, "--root", dir]);
  } catch (e: any) {
    status = e.status;
    out = e.stdout;
  }
  assert.equal(status, 1);
  assert.ok(fs.existsSync(path.join(dir, "app/ok.js")));
  assert.ok(!fs.existsSync(path.join(dir, "app/bad:name.js")));
  assert.match(out, /1 error line\(s\) excluded/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("snapshot emits a draft that apply can round-trip", () => {
  const { dir } = tmpSetup("");
  fs.mkdirSync(path.join(dir, "app/src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules/junk"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app/src/main.ts"), "");
  fs.writeFileSync(path.join(dir, "app/README.md"), "");
  const out = run(["snapshot", dir]);
  assert.equal(out, "drafteine 1\n\napp/\n  src/\n    main.ts\n  README.md\ndraft.dft\n");
  // node_modules ignored by default, included with --all
  const all = run(["snapshot", dir, "--all"]);
  assert.match(all, /node_modules\//);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("check: conforming tree passes, missing file fails", () => {
  const { dir, file } = tmpSetup("app/\n  main.ts\n  docs.md @optional\n");
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app/main.ts"), "");
  const ok = run(["check", file, "--root", dir]);
  assert.match(ok, /structure conforms/); // @optional absence is fine

  fs.rmSync(path.join(dir, "app/main.ts"));
  let status = 0;
  let out = "";
  try {
    out = run(["check", file, "--root", dir]);
  } catch (e: any) {
    status = e.status;
    out = e.stdout;
  }
  assert.equal(status, 1);
  assert.match(out, /app\/main\.ts: drafted but missing/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("check: @strict flags undeclared entries, @max-lines bounds files", () => {
  const { dir, file } = tmpSetup(
    "app/ @strict\n  main.ts @max-lines(3)\n"
  );
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app/main.ts"), "1\n2\n3\n4\n5\n");
  fs.writeFileSync(path.join(dir, "app/sprawl.ts"), "");
  let out = "";
  try {
    run(["check", file, "--root", dir]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.equal(e.status, 1);
    out = e.stdout;
  }
  assert.match(out, /app\/sprawl\.ts: undeclared direct child of @strict folder/);
  assert.match(out, /app\/main\.ts: 6 lines, exceeds @max-lines\(3\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("snapshot quotes names the bare grammar can't express", () => {
  const { dir } = tmpSetup("");
  fs.mkdirSync(path.join(dir, "release @ 2x"));
  fs.writeFileSync(path.join(dir, "release @ 2x", "notes #1.md"), "");
  const out = run(["snapshot", dir]);
  assert.match(out, /"release @ 2x"\//);
  assert.match(out, /  "notes #1\.md"/);
  // and the emitted draft round-trips through check cleanly
  fs.writeFileSync(path.join(dir, "snap.dft"), out.replace(/^draft\.dft\n?/m, ""));
  const checked = run(["check", path.join(dir, "snap.dft"), "--root", dir]);
  assert.match(checked, /structure conforms/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmt --check exits 1 on unformatted, 0 after --write", () => {
  const { dir, file } = tmpSetup("app/\n\n\n    over.txt\n");
  try {
    run(["fmt", file, "--check"]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.equal(e.status, 1);
  }
  run(["fmt", file, "--write"]);
  run(["fmt", file, "--check"]); // now clean — throws if not
  fs.rmSync(dir, { recursive: true, force: true });
});

test("codeowners emits patterns, parents before children, @ prefixed", () => {
  const { dir, file } = tmpSetup(
    [
      "packages/ @owner(core)",
      "  billing/ @owner(@org/billing-team money@example.com)",
      "    api.ts",
      "docs/",
      "  guide.md @owner(writers)",
    ].join("\n")
  );
  const out = run(["codeowners", file]);
  const lines = out.trim().split("\n");
  assert.match(lines[0], /^# Generated by drafteine/);
  assert.equal(lines[1], "/packages/ @core");
  assert.equal(lines[2], "/packages/billing/ @org/billing-team money@example.com");
  assert.equal(lines[3], "/docs/guide.md @writers");

  // --out then --check round-trips in sync
  const outFile = path.join(dir, "CODEOWNERS");
  run(["codeowners", file, "--out", outFile]);
  run(["codeowners", file, "--out", outFile, "--check"]); // throws if out of sync
  fs.appendFileSync(outFile, "/stale @nobody\n");
  try {
    run(["codeowners", file, "--out", outFile, "--check"]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.equal(e.status, 1);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("apply writes template content, preflight aborts everything", () => {
  const { dir, file } = tmpSetup(
    "app/\n  main.cpp @template(cpp/main.cpp)\n  README.md\n"
  );
  fs.mkdirSync(path.join(dir, "tpl/cpp"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tpl/cpp/main.cpp"), "int main() { return 0; }\n");
  fs.writeFileSync(
    path.join(dir, "drafteine.config.json"),
    JSON.stringify({ templates: "./tpl" })
  );

  run(["apply", file, "--root", dir]);
  assert.equal(
    fs.readFileSync(path.join(dir, "app/main.cpp"), "utf8"),
    "int main() { return 0; }\n"
  );
  assert.equal(fs.readFileSync(path.join(dir, "app/README.md"), "utf8"), "");

  // Re-apply never overwrites, even with a template configured.
  fs.writeFileSync(path.join(dir, "app/main.cpp"), "precious");
  run(["apply", file, "--root", dir]);
  assert.equal(fs.readFileSync(path.join(dir, "app/main.cpp"), "utf8"), "precious");

  // Missing template: hard error, nothing created at all.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "drafteine-"));
  const file2 = path.join(dir2, "draft.dft");
  fs.writeFileSync(file2, "app/\n  a.txt @template(gone.txt)\n  b.txt\n");
  fs.writeFileSync(
    path.join(dir2, "drafteine.config.json"),
    JSON.stringify({ templates: "./tpl" })
  );
  try {
    run(["apply", file2, "--root", dir2]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.equal(e.status, 1);
    assert.match(e.stderr ?? "", /could not be loaded/);
  }
  assert.ok(!fs.existsSync(path.join(dir2, "app")), "preflight must abort all creation");

  // Traversal and folder templates are rejected.
  fs.writeFileSync(file2, "evil.txt @template(../draft.dft)\n");
  try {
    run(["apply", file2, "--root", dir2]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.equal(e.status, 1);
  }
  fs.writeFileSync(file2, "sub/ @template(x)\n");
  try {
    run(["apply", file2, "--root", dir2]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.equal(e.status, 1);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test("json output for tree and check", () => {
  const { dir, file } = tmpSetup("app/ @strict\n  main.ts @max-lines(2)\n");
  const tree = JSON.parse(run(["tree", file, "--json"]));
  assert.equal(tree.tree[0].name, "app");
  assert.equal(tree.tree[0].kind, "folder");
  assert.equal(tree.tree[0].children[0].annotations[0].key, "max-lines");

  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app/main.ts"), "1\n2\n3\n4\n");
  let out = "";
  try {
    run(["check", file, "--root", dir, "--json"]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.equal(e.status, 1);
    out = e.stdout;
  }
  const report = JSON.parse(out);
  assert.equal(report.conforms, false);
  assert.equal(report.violations[0].kind, "max-lines");
  assert.equal(report.violations[0].line, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("docs renders a markdown repo map from comments", () => {
  const { dir, file } = tmpSetup(
    "app/ @strict # the application\n  main.ts @max-lines(9) # entry point\n"
  );
  const out = run(["docs", file]);
  assert.equal(
    out,
    "- **app/** \`@strict\`: the application\n  - \`main.ts\` \`@max-lines(9)\`: entry point\n"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("snapshot --gitignore respects patterns and negation", () => {
  const { dir } = tmpSetup("");
  fs.mkdirSync(path.join(dir, "build"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/app.log"), "");
  fs.writeFileSync(path.join(dir, "src/keep.log"), "");
  fs.writeFileSync(path.join(dir, "src/main.ts"), "");
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n*.log\n!keep.log\n");
  const out = run(["snapshot", dir, "--gitignore"]);
  assert.ok(!out.includes("build/"), "build dir ignored");
  assert.ok(!out.includes("app.log"), "glob ignored");
  assert.ok(out.includes("keep.log"), "negation kept");
  assert.ok(out.includes("main.ts"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("check modes print unified diffs", () => {
  const { dir, file } = tmpSetup("app/\n\n\n    x.txt\n");
  try {
    run(["fmt", file, "--check"]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.match(e.stderr ?? "", /@@ /);
    assert.match(e.stderr ?? "", /^\+.*x\.txt/m);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("check --all aggregates every configured contract", () => {
  const { dir } = tmpSetup("");
  fs.writeFileSync(path.join(dir, "ok.dft"), "present.txt\n");
  fs.writeFileSync(path.join(dir, "present.txt"), "");
  fs.writeFileSync(path.join(dir, "bad.dft"), "missing.txt\n");
  fs.writeFileSync(
    path.join(dir, "drafteine.config.json"),
    JSON.stringify({ contracts: ["ok.dft", "bad.dft"] })
  );
  let out = "";
  try {
    run(["check", "--all", "--root", dir]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.equal(e.status, 1);
    out = e.stdout;
  }
  assert.match(out, /✓ ok\.dft/);
  assert.match(out, /✗ bad\.dft/);
  assert.match(out, /missing\.txt: drafted but missing/);
  assert.match(out, /1\/2 contracts conform/);

  const json = JSON.parse(
    (() => {
      try {
        return run(["check", "--all", "--root", dir, "--json"]);
      } catch (e: any) {
        return e.stdout;
      }
    })()
  );
  assert.equal(json.conforms, false);
  assert.equal(json.contracts.length, 2);
  assert.equal(json.contracts[0].conforms, true);
  assert.equal(json.contracts[1].violations[0].kind, "missing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("accept amends the draft file and reports decisions", () => {
  const { dir, file } = tmpSetup("app/ @strict\n  main.ts @max-lines(2)\n");
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app/main.ts"), "1\n2\n3\n");
  fs.writeFileSync(path.join(dir, "app/extra.ts"), "");
  let status = 0;
  let err = "";
  try {
    run(["accept", file, "--root", dir]);
  } catch (e: any) {
    status = e.status;
    err = e.stderr;
  }
  assert.equal(status, 1); // the metric decision remains
  assert.match(err, /declared app\/extra\.ts/);
  assert.match(err, /decision left: .*max-lines/);
  const amended = fs.readFileSync(file, "utf8");
  assert.match(amended, /  extra\.ts/);
  // Membership now conforms: only the metric violation is left.
  try {
    run(["check", file, "--root", dir]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.ok(!/undeclared/.test(e.stdout));
    assert.match(e.stdout, /max-lines/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("init scaffolds contract, config, and agent rules once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drafteine-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/main.ts"), "");
  run(["init", "--root", dir, "--agents"]);
  const draft = fs.readFileSync(path.join(dir, "structure.dft"), "utf8");
  assert.match(draft, /src\/\n  main\.ts/);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "drafteine.config.json"), "utf8"));
  assert.deepEqual(cfg.contracts, ["structure.dft"]);
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.match(agents, /Never regenerate the whole draft/);
  // The scaffold conforms out of the box and init never overwrites.
  run(["check", "--all", "--root", dir]);
  fs.writeFileSync(path.join(dir, "structure.dft"), "precious\n");
  run(["init", "--root", dir]);
  assert.equal(fs.readFileSync(path.join(dir, "structure.dft"), "utf8"), "precious\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("owner resolves the deepest covering @owner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drafteine-"));
  fs.writeFileSync(
    path.join(dir, "structure.dft"),
    "services/ @owner(@acme/platform)\n  billing/ @owner(@acme/billing)\n    api.ts\ndocs/\n  guide.md\n"
  );
  assert.equal(run(["owner", "services/billing/api.ts", "--root", dir]).trim(), "@acme/billing");
  assert.equal(run(["owner", "services", "--root", dir]).trim(), "@acme/platform");
  try {
    run(["owner", "docs/guide.md", "--root", dir]);
    assert.fail("expected exit 1");
  } catch (e: any) {
    assert.equal(e.status, 1);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tree renders ASCII branches", () => {
  const { dir, file } = tmpSetup("app/\n  src/\n    main.js\n  README.md\n");
  const out = run(["tree", file]);
  assert.match(out, /└─ README\.md|├─ README\.md/);
  assert.match(out, /│ {2}└─ main\.js|│ {2}├─ main\.js| {3}└─ main\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});
