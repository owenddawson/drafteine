/**
 * Renderings of check results and policy explanations beyond plain text:
 * markdown for pull request comments, SARIF for code scanning UIs, and
 * the human explain output. Violations always point at the draft line,
 * the thing the reader can edit.
 */
import type { Explanation } from "@drafteine/core";

export interface ContractReport {
  draft: string;
  readable: boolean;
  draftErrors: number;
  violations: Array<{ path: string; kind: string; message: string; line: number }>;
}

const conforms = (r: ContractReport): boolean =>
  r.readable && r.draftErrors === 0 && r.violations.length === 0;

/** Markdown drift report, one section per contract. Renders the same in
 *  a GitHub comment, a Codeberg comment, or an agent's context window. */
export function renderMarkdown(reports: ContractReport[]): string {
  const out: string[] = [];
  for (const r of reports) {
    out.push(`### ${conforms(r) ? "✓" : "✗"} \`${r.draft}\``);
    if (!r.readable) {
      out.push("", "Cannot read the draft.");
    } else if (r.draftErrors > 0) {
      out.push("", `${r.draftErrors} draft error(s), contract not checked.`);
    } else if (r.violations.length > 0) {
      out.push("");
      for (const v of r.violations) out.push(`- ${v.message} (\`${r.draft}:${v.line}\`)`);
    } else {
      out.push("", "Structure conforms.");
    }
    out.push("");
  }
  const ok = reports.filter(conforms).length;
  out.push(`${ok}/${reports.length} contract${reports.length === 1 ? "" : "s"} conform`);
  return out.join("\n") + "\n";
}

/** SARIF 2.1.0 for code scanning: each violation is a result located at
 *  the declaring draft line. */
export function renderSarif(reports: ContractReport[], toolVersion: string): string {
  const results = reports.flatMap((r) => [
    ...(!r.readable
      ? [sarifResult("unreadable", `${r.draft}: cannot read the draft`, r.draft, 1)]
      : []),
    ...r.violations.map((v) => sarifResult(v.kind, v.message, r.draft, v.line)),
  ]);
  const ruleIds = [...new Set(results.map((x) => x.ruleId))];
  return JSON.stringify(
    {
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "drafteine",
              informationUri: "https://github.com/owenddawson/drafteine",
              version: toolVersion,
              rules: ruleIds.map((id) => ({ id })),
            },
          },
          results,
        },
      ],
    },
    null,
    2
  );
}

function sarifResult(ruleId: string, text: string, uri: string, line: number) {
  return {
    ruleId,
    level: "error" as const,
    message: { text },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri },
          region: { startLine: Math.max(1, line) },
        },
      },
    ],
  };
}

/** Human rendering of one path's effective policy with sources. */
export function renderExplain(x: Explanation, relPath: string, draftName: string): string {
  const out: string[] = [];
  out.push(
    x.declared
      ? `${relPath} is declared (${draftName}:${x.node?.line ? x.node.line.lineNo + 1 : "?"})`
      : x.matched.length > 0
        ? `${relPath} is not declared. Deepest declared ancestor: ${x.matched.join("/")}/`
        : `${relPath} is not declared and no declared folder covers it. Open world applies.`
  );
  for (const rule of x.rules) {
    const value = rule.value === null ? rule.key : `${rule.key}: ${rule.value}`;
    const source = `from ${rule.from || "."} (${draftName}:${rule.line})`;
    const via = rule.viaPreset ? ` via preset ${rule.viaPreset}` : "";
    const note = rule.note ? ` (${rule.note})` : "";
    out.push(`  ${value}  ${source}${via}${note}`);
  }
  if (x.rules.length === 0) {
    out.push("  no policy applies. Entries here are tolerated and unconstrained.");
  }
  return out.join("\n");
}
