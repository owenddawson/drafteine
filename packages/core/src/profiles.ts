/**
 * Attribute profiles: named policy presets declared in config.
 */
import type { ParseResult, ProfileMap } from "./types.js";
import { addError } from "./parser.js";

/** Keys a profile may never expand to: structure must stay explicit. */
const PROFILE_BANNED_KEYS = new Set(["strict", "optional"]);

/**
 * Resolve profile annotations in place. For each entry annotation whose
 * key names a profile, the profile's annotations are injected onto the
 * entry. Precedence: inherited defaults < profile expansion < explicit
 * annotations. An explicit annotation overriding a profile value emits an
 * info diagnostic. Two profiles disagreeing on a key is an error and the
 * entry is excluded from enforcement. Banned or profile-named expansion
 * keys are skipped. Run after parse and before runCheck.
 */
export function applyProfiles(result: ParseResult, profiles: ProfileMap): void {
  if (Object.keys(profiles).length === 0) return;
  for (const line of result.lines) {
    if ((line.kind !== "folder" && line.kind !== "file") || !line.node) continue;
    const explicitKeys = new Set(
      line.annotations.filter((a) => !a.fromProfile).map((a) => a.key)
    );
    const injected = new Map<string, { source: string; values: string[] | null }>();

    for (const ann of [...line.annotations]) {
      const profile = profiles[ann.key];
      if (!profile) continue;
      for (const [key, values] of Object.entries(profile.expands)) {
        if (PROFILE_BANNED_KEYS.has(key) || profiles[key] !== undefined) continue;
        if (explicitKeys.has(key)) {
          result.diagnostics.push({
            from: ann.from,
            to: ann.to,
            severity: "info",
            message: `Explicit @${key} overrides the value from profile @${ann.key}.`,
          });
          continue;
        }
        const prior = injected.get(key);
        if (prior) {
          const same =
            JSON.stringify(prior.values) === JSON.stringify(values ?? null);
          if (!same) {
            addError(line, result.diagnostics, {
              from: ann.from,
              to: ann.to,
              severity: "error",
              message: `Profiles @${prior.source} and @${ann.key} disagree on @${key}.`,
            });
            result.stats.errors++;
          }
          continue;
        }
        injected.set(key, { source: ann.key, values: values ?? null });
      }
    }

    for (const [key, inj] of injected) {
      const anchor = line.annotations.find((a) => a.key === inj.source)!;
      line.annotations.push({
        key,
        value: inj.values === null ? null : inj.values.join(", "),
        values: inj.values ?? [],
        from: anchor.from,
        to: anchor.to,
        fromProfile: inj.source,
      });
    }
  }
}
