/**
 * Config loading for the CLI: profiles, vocabulary, template directory,
 * and the contract list used by multi-contract check.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProfileMap, VocabularyMap } from "@drafteine/core";

export interface CliConfig {
  profiles: ProfileMap;
  templatesDir: string | null;
  vocabulary: VocabularyMap;
  contracts: Array<{ draft: string; root: string }>;
}

/** Profiles come from drafteine.config.json or the package.json
 *  "drafteine" key at --root. Config problems stay silent here, the
 *  extension and schema surface them. */
export function loadConfig(rootDir: string): CliConfig {
  const empty: CliConfig = { profiles: {}, templatesDir: null, vocabulary: {}, contracts: [] };
  let cfg: Record<string, unknown> | undefined;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(rootDir, "drafteine.config.json"), "utf8"));
  } catch {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
      cfg = pkg.drafteine;
    } catch {
      return empty;
    }
  }
  const templatesRel = (cfg as { templates?: unknown } | undefined)?.templates;
  const templatesDir =
    typeof templatesRel === "string" ? path.resolve(rootDir, templatesRel) : null;
  return {
    profiles: parseProfileList((cfg as { profiles?: unknown } | undefined)?.profiles),
    templatesDir,
    vocabulary: parseVocabList((cfg as { annotations?: unknown } | undefined)?.annotations),
    contracts: parseContracts((cfg as { contracts?: unknown } | undefined)?.contracts, rootDir),
  };
}

function parseContracts(
  list: unknown,
  rootDir: string
): Array<{ draft: string; root: string }> {
  if (!Array.isArray(list)) return [];
  const out: Array<{ draft: string; root: string }> = [];
  const inside = (p: string): boolean => p === rootDir || p.startsWith(rootDir + path.sep);
  for (const entry of list) {
    const draft = typeof entry === "string" ? entry : (entry as { draft?: string }).draft;
    const rootRel = typeof entry === "string" ? "." : (entry as { root?: string }).root ?? ".";
    if (!draft) continue;
    const draftPath = path.resolve(rootDir, draft);
    const contractRoot = path.resolve(rootDir, rootRel);
    if (!inside(draftPath) || !inside(contractRoot)) continue;
    out.push({ draft: draftPath, root: contractRoot });
  }
  return out;
}

function parseVocabList(list: unknown): VocabularyMap {
  if (!Array.isArray(list)) return {};
  const map: VocabularyMap = {};
  for (const entry of list) {
    const e = entry as { name?: string; value?: string };
    if (e.name && /^[A-Za-z][\w-]*$/.test(e.name)) map[e.name] = { value: e.value };
  }
  return map;
}

function parseProfileList(list: unknown): ProfileMap {
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

