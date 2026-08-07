/**
 * Validation and completion data for drafteine.config.json. The config is
 * its own language so it can carry an icon, which detaches it from the
 * built-in JSON service. This module replaces that service with the same
 * rules the JSON schema encodes.
 */
import { DiagnosticSeverity, type Diagnostic, type FoldingRange } from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";

/* ---------------- drafteine.config.json validation --------------------
 * The config file is its own language so it can carry an icon. The
 * built-in JSON service no longer sees it, so this server validates it
 * with the same rules the JSON schema encodes. */

export const CONFIG_KEYS = new Set(["contracts", "templates", "profiles", "annotations"]);
const NAME_RE = /^[A-Za-z][\w-]*$/;

export function isConfigDoc(doc: TextDocument): boolean {
  return doc.languageId === "drafteine-config";
}

export function validateConfig(doc: TextDocument): Diagnostic[] {
  const text = doc.getText();
  const keyRange = (needle: string) => {
    const i = text.indexOf(`"${needle}"`);
    const from = i < 0 ? 0 : i;
    const to = i < 0 ? Math.min(1, text.length) : i + needle.length + 2;
    return { start: doc.positionAt(from), end: doc.positionAt(to) };
  };
  const diag = (needle: string, message: string, error = true): Diagnostic => ({
    range: keyRange(needle),
    severity: error ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    message,
    source: "drafteine",
  });

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const m = /position (\d+)/.exec(String(e));
    const pos = m ? Number(m[1]) : 0;
    return [
      {
        range: { start: doc.positionAt(pos), end: doc.positionAt(Math.min(pos + 1, text.length)) },
        severity: DiagnosticSeverity.Error,
        message: `Invalid JSON. ${(e as Error).message}`,
        source: "drafteine",
      },
    ];
  }
  const out: Diagnostic[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [diag("", "The config must be a JSON object.")];
  }
  const cfg = data as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (!CONFIG_KEYS.has(key)) out.push(diag(key, `Unknown key "${key}".`, false));
  }
  if (cfg.templates !== undefined && typeof cfg.templates !== "string") {
    out.push(diag("templates", "templates must be a path string."));
  }
  if (cfg.contracts !== undefined) {
    if (!Array.isArray(cfg.contracts)) out.push(diag("contracts", "contracts must be an array."));
    else {
      for (const entry of cfg.contracts) {
        if (typeof entry === "string") continue;
        const e = entry as { draft?: unknown; root?: unknown };
        if (typeof entry !== "object" || entry === null || typeof e.draft !== "string") {
          out.push(diag("contracts", 'Each contract is a path string or { "draft": path, "root": dir }.'));
          break;
        }
      }
    }
  }
  if (cfg.profiles !== undefined) {
    if (!Array.isArray(cfg.profiles)) out.push(diag("profiles", "profiles must be an array."));
    else {
      for (const entry of cfg.profiles) {
        const e = entry as { name?: unknown; expands?: unknown };
        if (typeof e?.name !== "string" || !NAME_RE.test(e.name)) {
          out.push(diag("profiles", "Each profile needs a name like a-word-1."));
          continue;
        }
        if (typeof e.expands !== "object" || e.expands === null) {
          out.push(diag(e.name, `Profile "${e.name}" needs an expands object.`));
          continue;
        }
        for (const k of Object.keys(e.expands as object)) {
          if (k === "strict" || k === "optional") {
            out.push(diag(k, "Profiles may not expand @strict or @optional. Structure stays explicit."));
          }
        }
      }
    }
  }
  if (cfg.annotations !== undefined) {
    if (!Array.isArray(cfg.annotations)) out.push(diag("annotations", "annotations must be an array."));
    else {
      for (const entry of cfg.annotations) {
        const e = entry as { name?: unknown; value?: unknown; appliesTo?: unknown };
        if (typeof e?.name !== "string" || !NAME_RE.test(e.name)) {
          out.push(diag("annotations", "Each annotation needs a name like a-word-1."));
          continue;
        }
        if (e.value !== undefined && !["flag", "string", "number"].includes(e.value as string)) {
          out.push(diag(e.name, `Annotation "${e.name}": value must be flag, string, or number.`));
        }
        if (e.appliesTo !== undefined && !["file", "folder", "both"].includes(e.appliesTo as string)) {
          out.push(diag(e.name, `Annotation "${e.name}": appliesTo must be file, folder, or both.`));
        }
      }
    }
  }
  return out;
}

export const CONFIG_KEY_DOCS: Record<string, string> = {
  contracts: "Drafts that check enforces continuously and via check --all.",
  templates: "Template directory backing @template(path) at apply time.",
  profiles: "Named policy presets usable as @name in drafts.",
  annotations: "Custom annotation vocabulary with value shapes.",
};


/** Stable two-space pretty print. Key order preserved, strict JSON only. */
export function formatConfig(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2) + "\n";
  } catch {
    return null; // broken JSON is left alone, diagnostics already point at it
  }
}

/** Brace and bracket folding for config documents. */
export function configFoldingRanges(text: string): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const stack: number[] = [];
  let line = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") line++;
    else if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(line);
    else if (ch === "}" || ch === "]") {
      const start = stack.pop();
      if (start !== undefined && line > start) {
        ranges.push({ startLine: start, endLine: line - 1 });
      }
    }
  }
  return ranges;
}
