/**
 * Config loading for the CLI: machine-local plumbing only. Vocabulary,
 * template directory, and the contract list used by multi-contract
 * check. Policy (presets) lives in the draft, never here.
 */
import fs from "node:fs";
import path from "node:path";
import type { VocabularyMap } from "@drafteine/core";

export interface CliConfig {
  templatesDir: string | null;
  vocabulary: VocabularyMap;
  contracts: Array<{ draft: string; root: string }>;
}

/** Config comes from drafteine.config.json or the package.json
 *  "drafteine" key at --root. Config problems stay silent here, the
 *  extension and schema surface them. */
export function loadConfig(rootDir: string): CliConfig {
  const empty: CliConfig = { templatesDir: null, vocabulary: {}, contracts: [] };
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


