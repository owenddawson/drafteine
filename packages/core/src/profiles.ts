/**
 * Preset expansion. Presets are named policy bundles defined in the draft
 * (`preset pkg { … }`) and referenced on entries (`preset: pkg`). The
 * reference expands as if the preset's attributes were written on the
 * entry. Precedence: inherited defaults < preset expansion < explicit
 * attributes. An explicit attribute overriding a preset value emits an
 * info diagnostic. One preset per entry; the duplicate-key rule enforces
 * it. Structural keys never expand.
 */
import type { Annotation, ParseResult, ProfileMap } from "./types.js";

const EXPAND_BANNED_KEYS = new Set(["strict", "optional", "forbidden", "preset"]);

/**
 * Resolve `preset:` references in place. Runs inside parse for in-draft
 * presets; `extra` lets callers supply additional preset maps.
 */
export function applyProfiles(result: ParseResult, extra: ProfileMap = {}): void {
  const profiles: ProfileMap = { ...extra, ...result.presets };
  for (const line of result.lines) {
    if ((line.kind !== "folder" && line.kind !== "file") || !line.node) continue;
    const explicitKeys = new Set(
      line.annotations.filter((a) => !a.fromProfile && a.key !== "preset").map((a) => a.key)
    );
    const refs = line.annotations.filter((a) => a.key === "preset" && !a.fromProfile);
    for (const ref of refs) {
      if (ref.values.length !== 1) {
        fail(ref, "“preset:” takes exactly one name. Presets never compose.");
        continue;
      }
      const name = ref.values[0];
      const profile = profiles[name];
      if (!profile) {
        fail(ref, `Unknown preset “${name}”. Define it with “preset ${name} { … }”.`);
        continue;
      }
      for (const [key, values] of Object.entries(profile.expands)) {
        if (EXPAND_BANNED_KEYS.has(key)) continue;
        if (explicitKeys.has(key)) {
          result.diagnostics.push({
            from: ref.from,
            to: ref.to,
            severity: "info",
            message: `Explicit “${key}” overrides the value from preset “${name}”.`,
          });
          continue;
        }
        if (line.annotations.some((a) => a.key === key && a.fromProfile)) continue;
        line.annotations.push({
          key,
          value: values === null ? null : values.join(", "),
          values: values ?? [],
          from: ref.from,
          to: ref.to,
          fromProfile: name,
        });
      }
    }

    function fail(ref: Annotation, message: string): void {
      const d = { from: ref.from, to: ref.to, severity: "error" as const, message };
      line.errors.push(d);
      result.diagnostics.push(d);
    }
  }
}
