/**
 * Minimal unified diff for small text files, used by the --check modes.
 */

export function unifiedDiff(a: string, b: string, labelA: string, labelB: string): string {
  const al = a.split("\n");
  const bl = b.split("\n");

  // Longest common subsequence table. The inputs are small config-sized files.
  const n = al.length;
  const m = bl.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = al[i] === bl[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  type Op = { tag: " " | "-" | "+"; text: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      ops.push({ tag: " ", text: al[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ tag: "-", text: al[i++] });
    } else {
      ops.push({ tag: "+", text: bl[j++] });
    }
  }
  while (i < n) ops.push({ tag: "-", text: al[i++] });
  while (j < m) ops.push({ tag: "+", text: bl[j++] });

  // Hunks with two lines of context.
  const out: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  const context = 2;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].tag === " ") {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    let quiet = 0;
    while (end < ops.length && quiet <= context * 2) {
      quiet = ops[end].tag === " " ? quiet + 1 : 0;
      end++;
    }
    end = Math.min(ops.length, end);
    let aLine = 1;
    let bLine = 1;
    for (let p = 0; p < start; p++) {
      if (ops[p].tag !== "+") aLine++;
      if (ops[p].tag !== "-") bLine++;
    }
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((o) => o.tag !== "+").length;
    const bCount = hunk.filter((o) => o.tag !== "-").length;
    out.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    for (const op of hunk) out.push(op.tag + op.text);
    k = end;
  }
  return out.join("\n");
}
