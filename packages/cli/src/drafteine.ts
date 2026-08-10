#!/usr/bin/env node
/**
 * drafteine. Draft, materialize, and enforce file trees.
 *
 *   drafteine plan     <file|-> [--root DIR]              show what apply would create
 *   drafteine apply    <file|-> [--root DIR] [--dry-run]  create it (never overwrites)
 *   drafteine tree     <file|->                           render the draft as an ASCII tree
 *   drafteine check    <file|-> [--root DIR]              verify reality conforms to the draft
 *   drafteine snapshot [dir] [--all]                      emit a .dft from a real directory
 *
 * `-` (or piping with no file argument) reads the draft from stdin.
 *
 * Check semantics: drafted entries must exist and missing ones are
 * violations, extra files are fine. @optional exempts an entry. @strict
 * on a folder makes undeclared entries inside it violations. @max-lines(n)
 * bounds a file.
 *
 * Exit codes: 0 ok · 1 draft errors or check violations · 2 usage/io error
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { unifiedDiff } from "./diff.js";
import { loadConfig } from "./config.js";
import { resolveOwner, runInit } from "./scaffold.js";
import { gitignoreMatcher } from "./gitignore.js";
import {
  parse,
  format,
  quoteName,
  runCheck,
  runApply,
  acceptViolations,
  applyProfiles,
  validateVocabulary,
  SPEC_VERSION,
  type ApplyIO,
  type CheckIO,
  type ParseResult,
  type TreeNode,
} from "@drafteine/core";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const amber = (s: string) => c(33, s);
const blue = (s: string) => c(36, s);
const red = (s: string) => c(31, s);
const dim = (s: string) => c(2, s);
const green = (s: string) => c(32, s);

const COMMANDS = ["plan", "apply", "tree", "check", "snapshot", "fmt", "codeowners", "docs", "accept", "init", "owner"] as const;
type Command = (typeof COMMANDS)[number];

function usage(code = 2): never {
  console.error(
    `usage: drafteine <plan|apply|tree|check> <file.dft | -> [--root DIR] [--dry-run]\n` +
      `       drafteine fmt <file.dft | -> [--write | --check] [--align]\n` +
      `       drafteine accept <file.dft> [--root DIR] [--prune]\n` +
      `       drafteine codeowners <file.dft | -> [--out FILE] [--check]\n` +
      `       drafteine snapshot [dir] [--all]\n` +
      `       drafteine init [--root DIR] [--agents]   scaffold contract, config, agent rules\n` +
      `       drafteine owner <path> [--root DIR]      who owns this path per the contract\n` +
      `       cat file.dft | drafteine plan`
  );
  process.exit(code);
}

function fail(msg: string): never {
  console.error(red("error: ") + msg);
  process.exit(2);
}

const [, , commandArg, ...rest] = process.argv;
if (!commandArg || ["-h", "--help", "help"].includes(commandArg)) usage(0);
if (commandArg === "--version" || commandArg === "version") {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  console.log(pkg.version);
  process.exit(0);
}
if (!(COMMANDS as readonly string[]).includes(commandArg)) usage();
const command = commandArg as Command;

const args = {
  file: null as string | null,
  root: process.cwd(),
  dryRun: false,
  all: false,
  write: false,
  checkFmt: false,
  out: null as string | null,
  json: false,
  gitignore: false,
  align: false,
  prune: false,
  agents: false,
};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--root") args.root = rest[++i] ?? fail("--root needs a value");
  else if (a === "--dry-run") args.dryRun = true;
  else if (a === "--all") args.all = true;
  else if (a === "--json") args.json = true;
  else if (a === "--align") args.align = true;
  else if (a === "--gitignore") args.gitignore = true;
  else if (a === "--prune") args.prune = true;
  else if (a === "--agents") args.agents = true;
  else if (a === "--write") args.write = true;
  else if (a === "--out") args.out = rest[++i] ?? fail("--out needs a value");
  else if (a === "--check") args.checkFmt = true;
  else if (a.startsWith("-") && a !== "-") fail(`unknown flag ${a}`);
  else if (!args.file) args.file = a;
  else fail(`unexpected argument ${a}`);
}

if (command === "init") {
  for (const note of runInit(path.resolve(args.root), args.agents)) {
    console.error(dim(note));
  }
  console.error(dim("next: review structure.dft, add @strict and ceilings where you care, then: drafteine check --all"));
  process.exit(0);
}

if (command === "owner") {
  if (!args.file) usage();
  const draft = path.join(path.resolve(args.root), "structure.dft");
  let src: string;
  try {
    src = fs.readFileSync(draft, "utf8");
  } catch {
    fail(`cannot read ${draft}`);
  }
  const owner = resolveOwner(src, args.file);
  if (owner === null) {
    console.error(dim("no owner declared"));
    process.exit(1);
  }
  console.log(owner);
  process.exit(0);
}

/* ---------------- snapshot: real directory → .dft --------------------- */

const SNAPSHOT_IGNORE = new Set([".git", "node_modules"]);
let snapshotIgnore: ((relPath: string, isDir: boolean) => boolean) | null = null;
/** Names no draft can express even quoted: forbidden portability chars,
 *  control chars, and the dot names. Everything else quotes cleanly. */
const UNREPRESENTABLE_NAME = /[\\:*?"<>|\x00-\x1f]|^\.{1,2}$/;

if (command === "snapshot") {
  const dir = path.resolve(args.file ?? ".");
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    fail(`cannot read directory ${dir}`);
  }
  if (!stat.isDirectory()) fail(`${dir} is not a directory`);
  if (args.gitignore) {
    try {
      snapshotIgnore = gitignoreMatcher(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"));
    } catch {
      snapshotIgnore = null; // no .gitignore present is fine
    }
  }
  const lines: string[] = [];
  snapshotWalk(dir, 0, lines, "");
  if (lines.length === 0) console.error(dim("# (empty directory)"));
  else console.log(["drafteine 1", ""].concat(lines).join("\n"));
  process.exit(0);
}

function snapshotWalk(dir: string, depth: number, out: string[], rel: string): void {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory: skip silently rather than abort the draft
  }
  const visible = entries.filter((e) => args.all || !SNAPSHOT_IGNORE.has(e.name));
  // Folders first, each group in codepoint order, deterministic across locales.
  visible.sort((a, b) =>
    a.isDirectory() === b.isDirectory()
      ? a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      : a.isDirectory() ? -1 : 1
  );
  for (const e of visible) {
    const isDir = e.isDirectory(); // symlinked dirs report false: treated as files, no loops
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    if (snapshotIgnore && snapshotIgnore(childRel, isDir)) continue;
    if (UNREPRESENTABLE_NAME.test(e.name)) {
      out.push(
        "  ".repeat(depth) +
          `# skipped (unrepresentable name): ${e.name.replace(/[\r\n]/g, " ")}`
      );
      continue;
    }
    out.push("  ".repeat(depth) + quoteName(e.name) + (isDir ? "/" : ""));
    if (isDir) snapshotWalk(path.join(dir, e.name), depth + 1, out, childRel);
  }
}

/* ---------------- check --all: every contract in the config ----------- */

function makeCheckIO(base: string): CheckIO {
  const safe = (p: string): string => {
    const abs = path.resolve(base, p);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      fail(`refusing path outside root: ${p}`);
    }
    return abs;
  };
  return {
    kind(p) {
      const abs = safe(p);
      if (!fs.existsSync(abs)) return "missing";
      return fs.statSync(abs).isDirectory() ? "dir" : "file";
    },
    readdir: (p) => fs.readdirSync(safe(p)),
    countLines: (p) => fs.readFileSync(safe(p), "utf8").split("\n").length,
    fileSize: (p) => fs.statSync(safe(p)).size,
  };
}

if (command === "check" && !args.file && (args.all || process.stdin.isTTY)) {
  const rootDir = path.resolve(args.root);
  const cfg = loadConfig(rootDir);
  if (cfg.contracts.length === 0) {
    fail('no contracts configured. Add "contracts" to drafteine.config.json or pass a draft file.');
  }
  const reports = cfg.contracts.map((contract) => {
    const rel = path.relative(rootDir, contract.draft) || contract.draft;
    let text: string;
    try {
      text = fs.readFileSync(contract.draft, "utf8");
    } catch {
      return { draft: rel, readable: false, draftErrors: 0, violations: [] as ReturnType<typeof runCheck> };
    }
    const res = parse(text);
    applyProfiles(res, cfg.profiles);
    validateVocabulary(res, cfg.vocabulary);
    const violations = res.stats.errors > 0 ? [] : runCheck(res.root, makeCheckIO(contract.root));
    return { draft: rel, readable: true, draftErrors: res.stats.errors, violations };
  });

  const conforms = (r: (typeof reports)[number]): boolean =>
    r.readable && r.draftErrors === 0 && r.violations.length === 0;
  const ok = reports.filter(conforms).length;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          conforms: ok === reports.length,
          contracts: reports.map((r) => ({
            draft: r.draft,
            conforms: conforms(r),
            readable: r.readable,
            draftErrors: r.draftErrors,
            violations: r.violations.map((v) => ({
              path: v.path,
              kind: v.kind,
              message: v.message,
              line: v.node.line!.lineNo + 1,
            })),
          })),
        },
        null,
        2
      )
    );
    process.exit(ok === reports.length ? 0 : 1);
  }

  for (const r of reports) {
    if (conforms(r)) {
      console.log(`${green("✓")} ${r.draft}`);
      continue;
    }
    if (!r.readable) {
      console.log(`${red("✗")} ${r.draft} ${dim("(cannot read draft)")}`);
      continue;
    }
    if (r.draftErrors > 0) {
      console.log(`${red("✗")} ${r.draft} ${dim(`(${r.draftErrors} draft error(s), not checked)`)}`);
      continue;
    }
    console.log(`${red("✗")} ${r.draft}`);
    for (const v of r.violations) console.log(`    ${v.message}`);
  }
  console.log(`\n${ok}/${reports.length} contracts conform`);
  process.exit(ok === reports.length ? 0 : 1);
}

/* ---------------- draft-reading commands ------------------------------ */

// No file argument + piped stdin means read the draft from stdin.
if (!args.file && !process.stdin.isTTY) args.file = "-";
if (!args.file) usage();

let source: string;
try {
  source = args.file === "-"
    ? fs.readFileSync(0, "utf8") // fd 0 = stdin
    : fs.readFileSync(args.file, "utf8");
} catch (e) {
  fail(`cannot read ${args.file === "-" ? "stdin" : args.file}: ${(e as Error).message}`);
}

const displayName = args.file === "-" ? "<stdin>" : args.file;
const result = parse(source);

const config = loadConfig(path.resolve(args.root));
if (command === "check" || command === "codeowners") {
  applyProfiles(result, config.profiles);
}
if (command === "check") {
  validateVocabulary(result, config.vocabulary);
}
const { errors, warnings } = result.stats;

for (const d of result.diagnostics) {
  const line = result.lines.find((l) => d.from >= l.from && d.from <= l.to);
  const where = `${displayName}:${(line?.lineNo ?? 0) + 1}`;
  const tag =
    d.severity === "error" ? red("error") : d.severity === "warning" ? amber("warning") : dim("info");
  console.error(`${dim(where)} ${tag} ${d.message}`);
}

// The no-rewrite rule: reading a newer format degrades gracefully, but
// rewriting the draft or materializing from a possible misread does not.
if (
  result.version > SPEC_VERSION &&
  (command === "fmt" || command === "accept" || (command === "apply" && !args.dryRun))
) {
  fail(
    `${displayName} declares Drafteine format ${result.version}. This tool implements format ${SPEC_VERSION} and will not ${
      command === "fmt" ? "reformat" : command === "accept" ? "amend" : "materialize"
    } it. Upgrade drafteine.`
  );
}

/* ---------------- codeowners: emit ownership from @owner --------------- */

if (command === "codeowners") {
  const lines: string[] = [
    `# Generated by drafteine from ${displayName}. Edit the draft, not this file.`,
  ];
  const walk = (node: TreeNode, prefix: string): void => {
    for (const child of node.children) {
      if (child.line!.errors.some((e) => e.severity === "error")) continue;
      const p = prefix + child.name;
      const owner = child.annotations.find((a) => a.key === "owner");
      if (owner && owner.value) {
        const owners = owner.value
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => (t.includes("@") ? t : "@" + t))
          .join(" ");
        // Parents emit before children. CODEOWNERS applies the last
        // matching rule, so deeper entries override their ancestors.
        const pattern = "/" + p.replace(/ /g, "\\ ") + (child.isFolder ? "/" : "");
        lines.push(`${pattern} ${owners}`);
      }
      if (child.isFolder) walk(child, p + "/");
    }
  };
  walk(result.root, "");
  const output = lines.join("\n") + "\n";
  const outPath = args.out ?? "CODEOWNERS";
  if (args.checkFmt) {
    let existing = "";
    try {
      existing = fs.readFileSync(outPath, "utf8");
    } catch {
      // A missing file counts as out of sync.
    }
    if (existing === output) {
      console.error(dim(`${outPath} is in sync`));
      process.exit(errors > 0 ? 1 : 0);
    }
    console.error(`${amber("out of sync:")} ${outPath}`);
    console.error(unifiedDiff(existing, output, outPath, `${outPath} (generated)`));
    process.exit(1);
  }
  if (args.out) {
    fs.writeFileSync(args.out, output);
    console.error(dim(`wrote ${args.out}`));
  } else {
    process.stdout.write(output);
  }
  process.exit(errors > 0 ? 1 : 0);
}

/* ---------------- fmt: canonical formatting --------------------------- */

if (command === "fmt") {
  const formatted = format(source, { align: args.align });
  if (args.checkFmt) {
    if (formatted === source) process.exit(0);
    console.error(`${amber("would reformat")} ${displayName}`);
    console.error(unifiedDiff(source, formatted, displayName, `${displayName} (formatted)`));
    process.exit(1);
  }
  if (args.write) {
    if (args.file === "-") fail("--write needs a file, not stdin");
    if (formatted !== source) fs.writeFileSync(args.file!, formatted);
    console.error(dim(formatted === source ? "already formatted" : `formatted ${displayName}`));
    process.exit(0);
  }
  process.stdout.write(formatted);
  process.exit(0);
}

const rootDir = path.resolve(args.root);

/** Resolve a draft path under root, refusing anything that escapes it. */
function resolveSafe(opPath: string): string {
  const abs = path.resolve(rootDir, opPath);
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
    fail(`refusing path outside --root: ${opPath}`);
  }
  return abs;
}

function nodeJson(n: TreeNode): unknown {
  return {
    name: n.name,
    kind: n.isFolder ? "folder" : "file",
    line: n.line!.lineNo + 1,
    annotations: n.annotations.map((a) => ({
      key: a.key,
      value: a.value,
      values: a.values,
      ...(a.fromProfile ? { fromProfile: a.fromProfile } : {}),
    })),
    errors: n.line!.errors.map((e) => e.message),
    children: n.children.map(nodeJson),
  };
}

if (command === "tree") {
  if (args.json) {
    console.log(
      JSON.stringify(
        { indentUnit: result.indentUnit, stats: result.stats, tree: result.root.children.map(nodeJson) },
        null,
        2
      )
    );
    process.exit(errors > 0 ? 1 : 0);
  }
  renderAscii(result);
  process.exit(errors > 0 ? 1 : 0);
}

if (command === "docs") {
  const lines: string[] = [];
  for (const line of result.lines) {
    if (line.kind !== "folder" && line.kind !== "file") continue;
    const indent = "  ".repeat(line.depth);
    const label = line.isFolder ? `**${line.name}/**` : `\`${line.name}\``;
    const anns = line.annotations
      .filter((a) => !a.fromProfile)
      .map((a) => `\`@${a.key}${a.value !== null ? `(${a.value})` : ""}\``)
      .join(" ");
    const comment = line.spans.comment
      ? ": " + line.raw.slice(line.spans.comment[0] - line.from).replace(/^#\s*/, "").trimEnd()
      : "";
    lines.push(`${indent}- ${label}${anns ? " " + anns : ""}${comment}`);
  }
  console.log(lines.join("\n"));
  process.exit(errors > 0 ? 1 : 0);
}

/* ---------------- accept: reconcile the draft with reality ------------ */

if (command === "accept") {
  const violations = runCheck(result.root, makeCheckIO(rootDir));
  const outcome = acceptViolations(source, result, violations, { prune: args.prune });
  if (outcome.text !== source) {
    if (args.file === "-") {
      process.stdout.write(outcome.text);
    } else {
      fs.writeFileSync(args.file!, outcome.text);
    }
  }
  for (const p of outcome.declared) {
    const shallow = p.endsWith("/")
      ? dim(" (unsealed directory, its contents remain unchecked)")
      : "";
    console.error(`${green("+")} declared ${p}${shallow}`);
  }
  for (const p of outcome.removed) console.error(`${red("-")} pruned ${p}`);
  const skippedMissing = violations.filter((v) => v.kind === "missing").length;
  if (!args.prune && skippedMissing > 0) {
    console.error(dim(`${skippedMissing} drafted entr(y/ies) missing on disk. Rerun with --prune to remove them.`));
  }
  for (const v of outcome.remaining.filter((r) => r.kind !== "missing" || args.prune)) {
    console.error(`${amber("decision left:")} ${v.message}`);
  }
  const decisions = outcome.remaining.filter((r) => r.kind !== "missing" || args.prune).length;
  console.error(
    dim(`declared ${outcome.declared.length}, pruned ${outcome.removed.length}, decisions left ${decisions}`)
  );
  process.exit(decisions > 0 ? 1 : 0);
}

/* ---------------- check: reality must conform to the draft ------------ */

if (command === "check") {
  const violations = runCheck(result.root, makeCheckIO(rootDir));

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          conforms: violations.length === 0 && errors === 0,
          violations: violations.map((v) => ({
            path: v.path,
            kind: v.kind,
            message: v.message,
            line: v.node.line!.lineNo + 1,
          })),
          draftErrors: errors,
        },
        null,
        2
      )
    );
    process.exit(violations.length === 0 && errors === 0 ? 0 : 1);
  }
  for (const v of violations) console.log(`${red("✗")} ${v.message}`);
  const clean = violations.length === 0 && errors === 0;
  console.log(
    clean
      ? `${green("✓")} structure conforms to ${displayName}`
      : `\n${violations.length} violation${violations.length === 1 ? "" : "s"}` +
        (errors > 0 ? red(`, ${errors} draft error(s)`) : "")
  );
  process.exit(clean ? 0 : 1);
}

/* ---------------- plan | apply ---------------------------------------- */

const applyIO: ApplyIO = {
  kind(p) {
    const abs = resolveSafe(p);
    if (!fs.existsSync(abs)) return "missing";
    return fs.statSync(abs).isDirectory() ? "dir" : "file";
  },
  mkdir: (p) => fs.mkdirSync(resolveSafe(p), { recursive: true }),
  write(p, content) {
    const abs = resolveSafe(p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (content === null) fs.closeSync(fs.openSync(abs, "a"));
    else fs.writeFileSync(abs, content, { flag: "wx" }); // create only, never truncate
  },
  template(name) {
    if (
      config.templatesDir === null ||
      name === "" ||
      path.isAbsolute(name) ||
      name.split(/[\\/]/).includes("..")
    ) {
      return null;
    }
    try {
      const joined = path.join(config.templatesDir, name);
      if (fs.lstatSync(joined).isSymbolicLink()) return null;
      const real = fs.realpathSync(joined);
      const realDir = fs.realpathSync(config.templatesDir);
      if (real !== realDir && !real.startsWith(realDir + path.sep)) return null;
      if (!fs.statSync(real).isFile()) return null;
      return fs.readFileSync(real);
    } catch {
      return null;
    }
  },
};

const outcome = runApply(result.root, applyIO, {
  dryRun: command === "plan" || args.dryRun,
});

if (outcome.errors.length > 0) {
  for (const e of outcome.errors) console.error(`${red("✗")} ${e}`);
  console.error(red("nothing was created"));
  process.exit(1);
}

let created = 0;
let existing = 0;
for (const { op, outcome: res } of outcome.results) {
  const verb = op.type === "mkdir" ? amber("mkdir") : blue("touch");
  const note = op.template ? dim(`  template: ${op.template}`) : "";
  if (res === "exists") {
    existing++;
    console.log(`${dim("·")} ${verb} ${op.path} ${dim("(exists, skipped)")}`);
  } else {
    created++;
    console.log(`${green("+")} ${verb} ${op.path}${note}`);
  }
}

const mode = command === "plan" || args.dryRun ? "would create" : "created";
console.log(
  `\n${mode} ${created}, skipped ${existing} existing` +
    (errors > 0 ? red(`, ${errors} error line(s) excluded`) : "") +
    (warnings > 0 ? amber(`, ${warnings} warning(s)`) : "")
);
process.exit(errors > 0 ? 1 : 0);

function renderAscii(res: ParseResult): void {
  const walk = (node: TreeNode, prefix: string): void => {
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      const isErr = child.line!.errors.some((e) => e.severity === "error");
      const label =
        (child.isFolder ? amber(child.name + "/") : child.name) +
        (child.annotations.length
          ? " " +
            dim(
              child.annotations
                .map((a) => (a.value ? `@${a.key}(${a.value})` : `@${a.key}`))
                .join(" ")
            )
          : "") +
        (isErr ? red("  ✗ " + child.line!.errors[0].message) : "");
      console.log(prefix + (last ? "└─ " : "├─ ") + label);
      if (child.isFolder) walk(child, prefix + (last ? "   " : "│  "));
    });
  };
  walk(res.root, "");
}
