import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, plan, runCheck } from "../dist/index.js";

type Kind = "file" | "dir" | "link";

/** Fake CheckIO over a path map, with typed entries so symlinks exist. */
function worldIO(world: Record<string, Kind>) {
  const childrenOf = (p: string) =>
    Object.keys(world).filter((k) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/"));
  return {
    kind: (p: string) =>
      world[p] === undefined ? ("missing" as const) : world[p] === "dir" ? ("dir" as const) : ("file" as const),
    readdir: (p: string) => childrenOf(p).map((k) => k.slice(p.length + 1)),
    countLines: () => 0,
    fileSize: () => 0,
    entries: (p: string) => childrenOf(p).map((k) => ({ name: k.slice(p.length + 1), kind: world[k] })),
  };
}

const kinds = (vs: ReturnType<typeof runCheck>) => vs.map((v) => `${v.kind}:${v.path}`).sort();

test("ban patterns flag matching entries through the whole real subtree", () => {
  const r = parse("vendor/ { ban: [*.bak, tmp/] }\n");
  const vs = runCheck(
    r.root,
    worldIO({
      vendor: "dir",
      "vendor/a.bak": "file",
      "vendor/ok.ts": "file",
      "vendor/tmp.txt": "file", // dir-only pattern must not match a file
      "vendor/deep": "dir",
      "vendor/deep/b.bak": "file",
      "vendor/deep/tmp": "dir",
    })
  );
  assert.deepEqual(kinds(vs), [
    "banned:vendor/a.bak",
    "banned:vendor/deep/b.bak",
    "banned:vendor/deep/tmp",
  ]);
  assert.match(vs[0].message, /matches ban: \*\.bak \(from vendor\/\)/);
});

test("bans beat declarations: required is unsatisfiable, optional may only be absent", () => {
  const r = parse("vendor/ { ban: [*.bak] }\n  keep.bak\n  gone.bak?\n");
  const absent = runCheck(r.root, worldIO({ vendor: "dir" }));
  assert.deepEqual(kinds(absent), ["banned:vendor/keep.bak"]);
  assert.match(absent[0].message, /cannot be satisfied/);

  const present = runCheck(r.root, worldIO({ vendor: "dir", "vendor/gone.bak": "file" }));
  assert.ok(present.some((v) => v.kind === "banned" && v.path === "vendor/gone.bak"));
});

test("bans accumulate downward and strict extras are not double-reported", () => {
  const r = parse("v/ { strict, ban: [*.log] }\n  sub/ { ban: [*.bak] }\n    ok.ts\n");
  const vs = runCheck(
    r.root,
    worldIO({
      v: "dir",
      "v/x.log": "file",
      "v/sub": "dir",
      "v/sub/y.log": "file",
      "v/sub/z.bak": "file",
      "v/sub/ok.ts": "file",
    })
  );
  assert.deepEqual(kinds(vs), ["banned:v/sub/y.log", "banned:v/sub/z.bak", "banned:v/x.log"]);
});

test("symlinks are never followed and dir-only patterns skip links", () => {
  const r = parse("v/ { ban: [tmp/, *.bak] }\n");
  const vs = runCheck(
    r.root,
    worldIO({
      v: "dir",
      "v/tmp": "link", // a link named like a banned directory is not a directory
      "v/loop": "link",
      "v/loop/inner.bak": "file", // unreachable: links are not descended into
    })
  );
  assert.equal(vs.length, 0);
});

test("invalid ban patterns are bad-annotation violations", () => {
  const r = parse("v/ { ban: [a/b, \"\"] }\n");
  const vs = runCheck(r.root, worldIO({ v: "dir" }));
  assert.equal(vs.length, 2);
  assert.ok(vs.every((v) => v.kind === "bad-annotation"));
});

test("plan never creates banned entries, at any depth", () => {
  const r = parse("v/ { ban: [*.bak] }\n  a.bak\n  sub/\n    b.bak\n    c.ts\n");
  const ops = plan(r.root).map((o) => o.path);
  assert.deepEqual(ops, ["v/", "v/sub/", "v/sub/c.ts"]);
});
