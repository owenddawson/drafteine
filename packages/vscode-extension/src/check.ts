/**
 * Continuous contract checking: discovers contracts from
 * drafteine.config.json (or a package.json "drafteine" key), watches the
 * relevant directories, and re-runs check on change.
 *
 * Violations anchor to the DRAFT line that declared them (the thing the
 * user must edit), with relatedInformation pointing at violating files
 * that exist, plus Explorer badges via FileDecorationProvider.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  workspace,
  window,
  languages,
  Uri,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticRelatedInformation,
  Location,
  Position,
  Range,
  EventEmitter,
  FileDecoration,
  ThemeColor,
  RelativePattern,
  type ExtensionContext,
  type FileDecorationProvider,
  type WorkspaceFolder,
  type Disposable,
} from "vscode";
import {
  parse,
  runCheck,
  applyProfiles,
  validateVocabulary,
  type ParseResult,
  type CheckIO,
  type ProfileMap,
  type VocabularyMap,
} from "@drafteine/core";

interface Contract {
  draftPath: string;
  rootDir: string;
}

function parseVocab(cfg: Record<string, unknown> | undefined): VocabularyMap {
  const list = cfg?.annotations;
  if (!Array.isArray(list)) return {};
  const map: VocabularyMap = {};
  for (const entry of list) {
    const e = entry as { name?: string; value?: string };
    if (e.name && /^[A-Za-z][\w-]*$/.test(e.name)) map[e.name] = { value: e.value };
  }
  return map;
}

function parseProfiles(cfg: Record<string, unknown> | undefined): ProfileMap {
  const list = cfg?.profiles;
  if (!Array.isArray(list)) return {};
  const map: ProfileMap = {};
  for (const entry of list) {
    const e = entry as { name?: string; doc?: string; expands?: Record<string, unknown> };
    if (!e.name || !/^[A-Za-z][\w-]*$/.test(e.name) || !e.expands) continue;
    const expands: Record<string, string[] | null> = {};
    for (const [k, v] of Object.entries(e.expands)) {
      if (v === null) expands[k] = null;
      else if (typeof v === "string") expands[k] = v.split(",").map((x) => x.trim()).filter(Boolean);
      else if (Array.isArray(v)) expands[k] = v.map(String);
    }
    map[e.name] = { doc: e.doc, expands };
  }
  return map;
}

export function activateCheck(context: ExtensionContext): void {
  const collection = languages.createDiagnosticCollection("drafteine-check");
  const badgeEmitter = new EventEmitter<Uri[]>();
  let badged = new Map<string, string>(); // fsPath → violation message

  const provider: FileDecorationProvider = {
    onDidChangeFileDecorations: badgeEmitter.event,
    provideFileDecoration(uri) {
      const msg = badged.get(uri.fsPath);
      return msg
        ? new FileDecoration("✗", `Drafteine: ${msg}`, new ThemeColor("errorForeground"))
        : undefined;
    },
  };

  let generation = 0;
  let running = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchers: Disposable[] = [];
  let watchedKey = "";
  let warnedBothConfigs = false;

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 400);
  };

  let folderProfiles = new Map<string, ProfileMap>();
  let folderVocab = new Map<string, VocabularyMap>();

  function discoverContracts(folder: WorkspaceFolder): Contract[] {
    const base = folder.uri.fsPath;
    let raw: unknown;
    const cfgPath = path.join(base, "drafteine.config.json");
    const hasCfg = fs.existsSync(cfgPath);
    if (hasCfg) {
      try {
        raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      } catch {
        void window.showWarningMessage("Drafteine: drafteine.config.json is not valid JSON.");
        return [];
      }
    }
    try {
      const pkgPath = path.join(base, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
        if (pkg.drafteine !== undefined) {
          if (hasCfg) {
            if (!warnedBothConfigs) {
              warnedBothConfigs = true;
              void window.showWarningMessage(
                'Drafteine: both drafteine.config.json and a package.json "drafteine" key exist. Using drafteine.config.json.'
              );
            }
          } else {
            raw = pkg.drafteine;
          }
        }
      }
    } catch {
      // unreadable package.json is someone else's problem
    }

    folderProfiles.set(base, parseProfiles(raw as Record<string, unknown> | undefined));
    folderVocab.set(base, parseVocab(raw as Record<string, unknown> | undefined));
    const contracts = (raw as { contracts?: unknown } | undefined)?.contracts;
    if (!Array.isArray(contracts)) return [];
    const out: Contract[] = [];
    for (const entry of contracts) {
      const draft = typeof entry === "string" ? entry : (entry as { draft?: string }).draft;
      const rootRel = typeof entry === "string" ? "." : (entry as { root?: string }).root ?? ".";
      if (!draft) continue;
      const draftPath = path.resolve(base, draft);
      const rootDir = path.resolve(base, rootRel);
      const inside = (p: string): boolean => p === base || p.startsWith(base + path.sep);
      if (!inside(draftPath) || !inside(rootDir)) continue; // never leave the workspace
      out.push({ draftPath, rootDir });
    }
    return out;
  }

  function rangeAt(result: ParseResult, from: number, to: number): Range {
    const line =
      result.lines.find((l) => from >= l.from && from <= l.to) ?? result.lines[0];
    return new Range(
      new Position(line.lineNo, from - line.from),
      new Position(line.lineNo, Math.max(from - line.from + 1, to - line.from))
    );
  }

  function run(): void {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    const gen = ++generation;

    const all: Contract[] = [];
    folderProfiles = new Map();
    folderVocab = new Map();
    const contractProfiles = new Map<string, ProfileMap>();
    const contractVocab = new Map<string, VocabularyMap>();
    for (const folder of workspace.workspaceFolders ?? []) {
      const found = discoverContracts(folder);
      for (const c of found) {
        contractProfiles.set(c.draftPath, folderProfiles.get(folder.uri.fsPath) ?? {});
        contractVocab.set(c.draftPath, folderVocab.get(folder.uri.fsPath) ?? {});
      }
      all.push(...found);
    }

    // Watch each distinct contract root and each config location, never **/* .
    const watchRoots = new Set<string>();
    for (const c of all) {
      watchRoots.add(c.rootDir);
      watchRoots.add(path.dirname(c.draftPath));
    }
    for (const folder of workspace.workspaceFolders ?? []) watchRoots.add(folder.uri.fsPath);
    const key = [...watchRoots].sort().join("\n");
    if (key !== watchedKey) {
      watchedKey = key;
      for (const w of watchers) w.dispose();
      watchers = [];
      for (const root of watchRoots) {
        const isFolderRoot = (workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === root);
        // Contract roots watch deep. A workspace folder itself only watches
        // its top level for config and draft edits to keep the watcher cheap.
        const w = workspace.createFileSystemWatcher(
          new RelativePattern(root, isFolderRoot && !all.some((c) => c.rootDir === root) ? "*" : "**/*")
        );
        w.onDidCreate(schedule);
        w.onDidDelete(schedule);
        w.onDidChange(schedule);
        watchers.push(w);
      }
    }

    const perDraft = new Map<string, Diagnostic[]>();
    const nextBadged = new Map<string, string>();

    for (const contract of all) {
      let text: string;
      try {
        text = fs.readFileSync(contract.draftPath, "utf8");
      } catch {
        continue; // configured draft missing: nothing to check against
      }
      const result = parse(text);
      applyProfiles(result, contractProfiles.get(contract.draftPath) ?? {});
      validateVocabulary(result, contractVocab.get(contract.draftPath) ?? {});
      const key = Uri.file(contract.draftPath).fsPath;
      const diags = perDraft.get(key) ?? [];

      if (result.stats.errors > 0) {
        // A broken contract must be visible even when the draft isn't open.
        for (const d of result.diagnostics) {
          if (d.severity !== "error") continue;
          const diag = new Diagnostic(
            rangeAt(result, d.from, d.to),
            `${d.message} Contract not checked until this is fixed.`,
            DiagnosticSeverity.Error
          );
          diag.source = "drafteine check";
          diags.push(diag);
        }
        perDraft.set(key, diags);
        continue;
      }

      const io: CheckIO = {
        kind(p) {
          const abs = path.resolve(contract.rootDir, p);
          if (!abs.startsWith(contract.rootDir)) return "missing";
          if (!fs.existsSync(abs)) return "missing";
          return fs.statSync(abs).isDirectory() ? "dir" : "file";
        },
        readdir: (p) => fs.readdirSync(path.resolve(contract.rootDir, p)),
        countLines: (p) =>
          fs.readFileSync(path.resolve(contract.rootDir, p), "utf8").split("\n").length,
        fileSize: (p) => fs.statSync(path.resolve(contract.rootDir, p)).size,
      };

      for (const v of runCheck(result.root, io)) {
        const line = v.node.line!;
        const [from, to] = line.spans.name ?? [line.from, line.to];
        const diag = new Diagnostic(rangeAt(result, from, to), v.message, DiagnosticSeverity.Error);
        diag.source = "drafteine check";
        const target = path.join(contract.rootDir, v.path);
        if (v.kind !== "missing" && fs.existsSync(target)) {
          diag.relatedInformation = [
            new DiagnosticRelatedInformation(
              new Location(Uri.file(target), new Position(0, 0)),
              "violating entry"
            ),
          ];
          nextBadged.set(target, v.message);
        }
        diags.push(diag);
      }
      perDraft.set(key, diags);
    }

    if (gen === generation) {
      collection.clear();
      for (const [fsPath, diags] of perDraft) {
        collection.set(Uri.file(fsPath), diags);
      }
      const changed = new Set([...badged.keys(), ...nextBadged.keys()]);
      badged = nextBadged;
      badgeEmitter.fire([...changed].map((p) => Uri.file(p)));
    }
    running = false;
    if (dirty) {
      dirty = false;
      schedule();
    }
  }

  context.subscriptions.push(
    collection,
    badgeEmitter,
    window.registerFileDecorationProvider(provider),
    workspace.onDidChangeWorkspaceFolders(schedule),
    { dispose: () => watchers.forEach((w) => w.dispose()) }
  );
  schedule(); // initial run
}
