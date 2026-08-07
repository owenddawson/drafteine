/**
 * Live preview: renders the parse tree as a file-explorer style tree,
 * and the materialization plan as an ordered op list.
 * Error tolerant by design. Lines with errors render in place, flagged,
 * so the preview never "goes blank" mid-thought.
 */
import { plan, toScript, type ParseResult } from "@drafteine/core";

const FOLDER_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.6 1.8H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 13.8H3a1.5 1.5 0 0 1-1.5-1.5v-8.8z"/></svg>`;
const FILE_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.3L12.5 5v9A1.5 1.5 0 0 1 11 15.5H4A1.5 1.5 0 0 1 2.5 14V3A1.5 1.5 0 0 1 4 1.5z"/><path d="M9 1.5V5h3.5" fill="none" stroke-width="1.1" class="fold"/></svg>`;
const WARN_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15 13.7H1L8 1.8z"/><rect x="7.3" y="6" width="1.4" height="4" class="mark"/><rect x="7.3" y="11" width="1.4" height="1.4" class="mark"/></svg>`;

export function renderTree(container: HTMLElement, result: ParseResult): void {
  container.replaceChildren();

  const structural = result.lines.filter(
    (l) => l.kind === "folder" || l.kind === "file"
  );
  if (structural.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent =
      "Nothing drafted yet. Type a name in the editor. End it with / to make a folder.";
    container.append(empty);
    return;
  }

  for (const line of structural) {
    const hasError = line.errors.some((e) => e.severity === "error");
    const hasWarning = !hasError && line.errors.length > 0;

    const row = document.createElement("div");
    row.className = "tree-row";
    if (hasError) row.classList.add("is-error");
    if (hasWarning) row.classList.add("is-warning");
    row.dataset.line = String(line.lineNo + 1);

    for (let d = 0; d < line.depth; d++) {
      const guide = document.createElement("span");
      guide.className = "tree-guide";
      row.append(guide);
    }

    const icon = document.createElement("span");
    icon.className = "tree-icon " + (hasError ? "icon-warn" : line.isFolder ? "icon-folder" : "icon-file");
    icon.innerHTML = hasError ? WARN_ICON : line.isFolder ? FOLDER_ICON : FILE_ICON;
    row.append(icon);

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = line.name || "(unnamed)";
    row.append(name);

    for (const a of line.annotations) {
      const chip = document.createElement("span");
      chip.className = "tree-chip";
      chip.textContent = a.value === null ? `@${a.key}` : `@${a.key}(${a.value})`;
      row.append(chip);
    }

    if (line.errors.length > 0) {
      const note = document.createElement("span");
      note.className = "tree-error-note";
      note.textContent = line.errors[0].message;
      row.append(note);
    }

    container.append(row);
  }
}

export function renderPlan(
  container: HTMLElement,
  countEl: HTMLElement,
  result: ParseResult
): string {
  container.replaceChildren();
  const ops = plan(result.root);
  countEl.textContent =
    ops.length === 0 ? "no operations" : `${ops.length} operation${ops.length === 1 ? "" : "s"}`;

  if (ops.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "The plan lists what materializing would create. It only ever includes lines that parse clean.";
    container.append(empty);
    return "";
  }

  for (const op of ops) {
    const row = document.createElement("div");
    row.className = "plan-row";

    const verb = document.createElement("span");
    verb.className = "plan-verb " + (op.type === "mkdir" ? "verb-mkdir" : "verb-touch");
    verb.textContent = op.type === "mkdir" ? "mkdir" : "touch";
    row.append(verb);

    const path = document.createElement("span");
    path.className = "plan-path";
    path.textContent = op.path;
    row.append(path);

    if (op.template) {
      const t = document.createElement("span");
      t.className = "plan-template";
      t.textContent = `← ${op.template}`;
      row.append(t);
    }
    container.append(row);
  }
  return toScript(ops);
}

export function renderStatus(el: HTMLElement, result: ParseResult): void {
  const { folders, files, errors, warnings } = result.stats;
  const parts = [
    `${folders} folder${folders === 1 ? "" : "s"}`,
    `${files} file${files === 1 ? "" : "s"}`,
  ];
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  parts.push(errors === 0 ? "draft is clean" : `${errors} error${errors === 1 ? "" : "s"}`);
  el.textContent = parts.join("  ·  ");
  el.classList.toggle("has-errors", errors > 0);
}
