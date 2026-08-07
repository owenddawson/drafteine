/**
 * Bundle the extension client and the language server into self-contained
 * CJS files — the .vsix then needs no node_modules at all.
 */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

/* File colors come from GitHub Linguist's maintained dataset, generated
 * at build time. One class per extension, scoped to the colored theme. */
const linguist = createRequire(import.meta.url)("linguist-languages");
const extColor = new Map();
for (const lang of Object.values(linguist)) {
  if (!lang.color || !lang.extensions) continue;
  for (const ext of lang.extensions) {
    const key = ext.replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key && !extColor.has(key)) extColor.set(key, lang.color);
  }
}
/* Linguist colors target light backgrounds. Clamp luminance per scheme
 * so dark colors stay visible on dark themes and vice versa. */
const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
const luminance = (hex) =>
  (0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2)) / 255;
const mix = (hex, target, t) => {
  const c = (i) => Math.round(channel(hex, i) + (target - channel(hex, i)) * t);
  const to2 = (n) => n.toString(16).padStart(2, "0");
  return `#${to2(c(0))}${to2(c(1))}${to2(c(2))}`;
};

const rules = ["/* Generated from linguist-languages during build. Do not edit. */"];
for (const [ext, color] of extColor) {
  const selectors = (scheme) => [
    `${scheme}.theme-colored .icon.file.dfx-${ext} svg path`,
    `${scheme}.drafteine-fence.theme-colored .icon.file.dfx-${ext} svg path`,
  ];
  rules.push(`${selectors("").join(", ")} { stroke: ${color} !important; }`);
  const lum = luminance(color);
  if (lum < 0.3) {
    const lightened = mix(color, 255, (0.3 - lum) / (1 - lum) + 0.25);
    const sel = [...selectors(".vscode-dark "), ...selectors(".vscode-high-contrast ")];
    rules.push(`${sel.join(", ")} { stroke: ${lightened} !important; }`);
  } else if (lum > 0.75) {
    const darkened = mix(color, 0, 0.45);
    rules.push(`${selectors(".vscode-light ").join(", ")} { stroke: ${darkened} !important; }`);
  }
}
writeFileSync(new URL("./media/filecolors.css", import.meta.url), rules.join("\n") + "\n");
console.log(`filecolors.css: ${extColor.size} extensions from linguist`);


const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"], // provided by the VS Code runtime
});

await build({
  ...shared,
  entryPoints: ["../language-server/src/server.ts"],
  outfile: "dist/server.js",
});
