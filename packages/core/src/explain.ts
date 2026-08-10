/**
 * Explain: resolve the effective policy for one draft-relative path, with
 * the source of every rule. The answer to "why did check flag this" and
 * "what governs this spot", especially now that presets, inheritance,
 * path lines, and subtree bans add indirection.
 */
import type { ParseResult, TreeNode } from "./types.js";
import { globMatcher } from "./names.js";

export interface ExplainedRule {
  /** Attribute key, or a synthetic subject like "membership". */
  key: string;
  value: string | null;
  /** Draft-relative path of the entry that contributed the rule. */
  from: string;
  /** One-based line number of that entry in the draft. */
  line: number;
  /** Preset name when the rule arrived through a preset expansion. */
  viaPreset?: string;
  /** Extra prose: inheritance, ban match, strict consequences. */
  note?: string;
}

export interface Explanation {
  /** Segments actually matched against declared entries. */
  matched: string[];
  /** True when the full path is declared in the draft. */
  declared: boolean;
  /** The declared node when found. */
  node?: TreeNode;
  rules: ExplainedRule[];
}

/** Resolve the effective policy for `relPath` against a parsed draft. */
export function explain(result: ParseResult, relPath: string): Explanation {
  const segments = relPath.split("/").filter(Boolean);
  const rules: ExplainedRule[] = [];
  const lineOf = (node: TreeNode): number => (node.line ? node.line.lineNo + 1 : 0);
  const pathOf = (node: TreeNode): string => {
    const parts: string[] = [];
    for (let n: TreeNode | undefined = node; n && n.kind !== "root"; n = n.parent) {
      parts.unshift(n.name + (n.isFolder ? "/" : ""));
    }
    return parts.join("");
  };
  const attr = (node: TreeNode, key: string) => node.annotations.find((a) => a.key === key);
  const add = (node: TreeNode, key: string, value: string | null, note?: string): void => {
    const a = attr(node, key);
    rules.push({
      key,
      value,
      from: pathOf(node),
      line: lineOf(node),
      viaPreset: a?.fromProfile,
      note,
    });
  };

  // Walk as deep as the declared tree matches the path.
  const chain: TreeNode[] = [];
  let node: TreeNode = result.root;
  const matched: string[] = [];
  for (const segment of segments) {
    const next = node.children.find((c) => c.name === segment);
    if (!next) break;
    node = next;
    chain.push(node);
    matched.push(segment);
  }
  const declared = matched.length === segments.length;
  const leaf = chain[chain.length - 1];
  const leafName = segments[segments.length - 1] ?? relPath;

  // Metrics and ownership: the nearest declaring entry wins.
  for (const key of ["max-lines", "max-size", "owner"]) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const a = attr(chain[i], key);
      if (!a) continue;
      const own = declared && i === chain.length - 1;
      add(chain[i], key, a.value, own ? undefined : "inherited folder default");
      break;
    }
  }

  // Membership: how the immediate parent treats this entry.
  const parent = declared ? chain[chain.length - 2] : chain[chain.length - 1];
  if (parent && attr(parent, "strict")) {
    add(
      parent,
      "strict",
      null,
      declared
        ? "parent is strict, siblings must be declared"
        : "parent is strict, this undeclared path would violate unless allow-matched"
    );
    const allow = attr(parent, "allow");
    if (allow && !declared) {
      const tolerated = (allow.values ?? []).some((p) => globMatcher(p)(leafName, relPath.endsWith("/")));
      add(parent, "allow", allow.value, tolerated ? "this name matches, tolerated" : "no pattern matches this name");
    }
  }
  if (parent && attr(parent, "count")) add(parent, "count", attr(parent, "count")!.value);

  // Bans accumulate from every ancestor. Report each, noting matches.
  for (const anc of chain.slice(0, declared ? -1 : undefined)) {
    const ban = attr(anc, "ban");
    if (!ban) continue;
    const hit = (ban.values ?? []).find((p) => globMatcher(p)(leafName, relPath.endsWith("/")));
    add(anc, "ban", ban.value, hit ? `this name matches ${hit}, banned` : "no pattern matches this name");
  }

  // Facts on the entry itself.
  if (declared && leaf) {
    for (const a of leaf.annotations) {
      if (["max-lines", "max-size", "owner"].includes(a.key)) continue; // reported above
      if (a.key === "preset") {
        add(leaf, "preset", a.value, "expanded onto this entry");
        continue;
      }
      add(leaf, a.key, a.value, a.key === "optional" ? "check does not require it to exist" : undefined);
    }
  }

  return { matched, declared, node: leaf, rules };
}
