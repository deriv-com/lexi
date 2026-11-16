import type { RepoRegistry } from "./repo-registry";
import { defaultRepoRegistry } from "./platform-schema";

/**
 * Resolving a `platform` into the `config/repos.yaml` product key that serves
 * it.
 *
 * This is the dispatch/read counterpart to {@link platformSchemaProperty}. That
 * one builds the enum the model chooses FROM; this one resolves the value the
 * model chose. Both read the same registry, so the set of platforms offered and
 * the set that can actually be dispatched cannot drift apart.
 *
 * It replaces `platform === "web" ? "home_web" : "home_mobile"`, which had been
 * copied to six call sites. The problem with that ternary was not duplication:
 *
 *   - **It had no failure mode.** Every value that was not the literal `"web"`
 *     landed on the mobile repo — a third platform, a typo, an empty string,
 *     `"Web"`, `"web "`. Work was dispatched at the wrong repository with no
 *     error, and the wrong answer was indistinguishable from the right one.
 *   - **It was a second source of truth.** `repos.yaml` already states which key
 *     serves which platform. Restating that in code meant adding a repo was a
 *     code change in six places, and any one of them going stale routed silently.
 *
 * Deliberately does NOT normalise — no trimming, no case folding. `"Web"` and
 * `"web "` are unknown platforms, not `web`. Coercing near-misses would be the
 * same defect in a politer form: it decides on the caller's behalf what they
 * meant, and the caller never learns it was wrong.
 */

export const PLATFORM_PRODUCT_KEY_STATUS = {
  RESOLVED: "resolved",
  UNKNOWN_PLATFORM: "unknown_platform",
} as const;

export type PlatformProductKeyStatus =
  (typeof PLATFORM_PRODUCT_KEY_STATUS)[keyof typeof PLATFORM_PRODUCT_KEY_STATUS];

/**
 * The outcome of one lookup.
 *
 * Only the `RESOLVED` variant carries a `productKey`, exactly as
 * {@link CodeRepoKeyResolution} does. That is what makes the defect
 * unrepresentable rather than merely tested for: there is no key to read on the
 * failure branch, so a call site cannot fall through to a repo without the type
 * checker objecting. A runtime guard alone would leave the wrong code spellable.
 */
export type PlatformProductKeyResolution =
  | {
      status: typeof PLATFORM_PRODUCT_KEY_STATUS.RESOLVED;
      productKey: string;
      platform: string;
      slug: string;
    }
  | {
      status: typeof PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM;
      /** Rendered for the operator; may be any JSON value the model sent. */
      platform: string;
      knownPlatforms: string[];
    };

/** How a non-string arrives in a message without pretending it was a string. */
function render(platform: unknown): string {
  return typeof platform === "string" ? platform : JSON.stringify(platform) ?? String(platform);
}

/**
 * Resolve a platform to its product key, or report that it has none.
 *
 * `platform` is `unknown` on purpose. Every caller receives this value from
 * outside the type system — a model's tool-call arguments, an issue label, a
 * database column — so a parameter typed `"web" | "mobile"` would describe a
 * guarantee no caller can make, and the compiler would then vouch for a value
 * nothing had checked. The boundary is where the check belongs.
 *
 * Only repos holding the `code` role are candidates, via
 * {@link RepoRegistry.resolveByPlatform}: a platform whose repo cannot accept
 * code is not a dispatch target, and resolving one would produce a refusal
 * later and further away.
 */
export function resolvePlatformProductKey(
  registry: RepoRegistry,
  platform: unknown,
): PlatformProductKeyResolution {
  const knownPlatforms = registry.platformKeys();

  if (typeof platform !== "string" || platform === "") {
    return { status: PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM, platform: render(platform), knownPlatforms };
  }

  const repo = registry.resolveByPlatform(platform);
  if (!repo) {
    return { status: PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM, platform, knownPlatforms };
  }

  return {
    status: PLATFORM_PRODUCT_KEY_STATUS.RESOLVED,
    productKey: repo.key,
    platform,
    slug: repo.slug,
  };
}

/**
 * The same lookup against the process-wide registry, for call sites that have
 * no registry in scope. Shares {@link defaultRepoRegistry}'s memoized instance
 * with the tool schemas, which is the point: the enum the model is offered and
 * the mapping the dispatcher applies are read from one object, so they cannot
 * disagree even for one turn.
 */
export function platformProductKey(platform: unknown): PlatformProductKeyResolution {
  return resolvePlatformProductKey(defaultRepoRegistry(), platform);
}

/**
 * The same lookup over the READ surface — every repo holding `code`, including
 * placeholders.
 *
 * Pairs with {@link readPlatformSchemaProperty} exactly as
 * {@link resolvePlatformProductKey} pairs with `platformSchemaProperty`: the
 * enum a read tool offers and the resolution its handler performs come from one
 * list, so a value the model was shown can always be placed. Without this half,
 * widening only the enum would move the failure from "not offered" to "offered
 * and then refused", which is worse — the model would have no way to tell a
 * typo from a governance boundary.
 *
 * `knownPlatforms` on the failure branch is the READ list, because that is what
 * the caller was offered; naming the dispatch list here would tell a reader to
 * pick a value this tool never advertised.
 */
export function resolveReadPlatformProductKey(
  registry: RepoRegistry,
  platform: unknown,
): PlatformProductKeyResolution {
  const knownPlatforms = registry.readablePlatformKeys();

  if (typeof platform !== "string" || platform === "") {
    return { status: PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM, platform: render(platform), knownPlatforms };
  }

  const repo = registry.resolveReadableByPlatform(platform);
  if (!repo) {
    return { status: PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM, platform, knownPlatforms };
  }

  return {
    status: PLATFORM_PRODUCT_KEY_STATUS.RESOLVED,
    productKey: repo.key,
    platform,
    slug: repo.slug,
  };
}

/** {@link resolveReadPlatformProductKey} against the process-wide registry. */
export function readPlatformProductKey(platform: unknown): PlatformProductKeyResolution {
  return resolveReadPlatformProductKey(defaultRepoRegistry(), platform);
}

/**
 * The caller-facing sentence for a platform that resolved to nothing, or `null`
 * when there is nothing to report.
 *
 * Names the platforms that DO resolve, because the reader of this message is
 * usually the model that picked the bad value and can immediately pick a good
 * one — and because a registry-derived list stays correct when `repos.yaml`
 * changes, which a hard-coded `must be "web" or "mobile"` never did.
 */
export function describeUnknownPlatform(resolution: PlatformProductKeyResolution): string | null {
  if (resolution.status !== PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM) return null;

  const known = resolution.knownPlatforms.length
    ? resolution.knownPlatforms.map((p) => `"${p}"`).join(", ")
    : "none — no code repo in config/repos.yaml declares a platform";

  return (
    `platform ${JSON.stringify(resolution.platform)} matches no code repo in config/repos.yaml, ` +
    `so no repository was chosen (nothing was guessed). Known platforms: ${known}.`
  );
}
