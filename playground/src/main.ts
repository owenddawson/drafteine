import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./style.css";

import { createEditor } from "./editor";
import { renderTree, renderPlan, renderStatus } from "./preview";

const STARTER = `# Drafteine. Every line below becomes part of the tree on the right.
# Folders end with /. Attributes sit in { }. Try breaking a line.

drafteine 1

preset code { max-lines: 400 }

drafteine/ { strict, allow: [dist/, node_modules/] }
  src/ { preset: code }
    parser.ts
    editor.ts
    "release @ 2x.png"
  test/
    parser.test.ts
  main.cpp {
    template: cpp/main.cpp
    max-lines: 200
  }
  docs/?
  README.md # quick view of the whole structure
`;

const treeEl = document.getElementById("tree")!;
const planEl = document.getElementById("plan")!;
const planCountEl = document.getElementById("plan-count")!;
const statusEl = document.getElementById("status")!;
const copyBtn = document.getElementById("copy-script") as HTMLButtonElement;

let currentScript = "";

createEditor({
  parent: document.getElementById("editor")!,
  doc: STARTER,
  onParse(result) {
    renderTree(treeEl, result);
    currentScript = renderPlan(planEl, planCountEl, result);
    renderStatus(statusEl, result);
    copyBtn.disabled = currentScript === "";
  },
});

copyBtn.addEventListener("click", async () => {
  if (!currentScript) return;
  try {
    await navigator.clipboard.writeText(currentScript);
    copyBtn.textContent = "Copied";
  } catch {
    copyBtn.textContent = "Copy failed";
  }
  setTimeout(() => (copyBtn.textContent = "Copy shell script"), 1500);
});
