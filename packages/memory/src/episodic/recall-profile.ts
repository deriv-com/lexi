/**
 * How much memory one request is worth.
 *
 * The agent used to recall with two constants: `maxTokens: 1500` and
 * `input.text.slice(0, 500)`, on every turn regardless of what was asked. Both
 * were wrong in both directions.
 *
 *  - The **query clip** is the worse of the two, because it is silent. A long
 *    investigation request ("this regressed sometime after the 3rd, we changed
 *    the branch naming and the runner secrets that week, what did we decide
 *    about…") is well past 500 characters, and every term after the cut simply
 *    did not participate in relevance — so the recall was ranked against the
 *    opening sentence of the question and nothing else. Nothing in the reply
 *    indicated that most of the question had not been used for retrieval.
 *  - The **budget** is a flat 1500 whether the turn is "what do I usually
 *    mean by the app" or a cross-thread investigation. The small case pays for
 *    a pack it cannot use; the large case cannot ask for more.
 *
 * So the shape of the request picks the profile. This is deliberately a pure
 * function of the text: it is cheap, it is testable without a model, and the
 * deterministic-first rule puts plain code ahead of an inference call for a decision like this.
 *
 * **A profile is a request, not a grant.** `MemoryFacade.recall` clamps to
 * `min(asked, policy.budgets.maxMemoryTokens)` and the episode count is
 * clamped to `policy.budgets.maxEpisodesPerRecall`, so a profile can never
 * buy a bigger pack than the org has agreed to pay for.
 *
 * The example policy sets `maxMemoryTokens` to 4000, so the
 * investigation profile's token ask now lands rather than being clamped back
 * to the ordinary turn's budget. Note what that did NOT change: the common
 * turn still asks for `standard` (1500), so the higher ceiling widens one
 * classified case rather than every turn. If the ceiling is ever lowered again, the
 * symptom is not an error — the investigation profile quietly degrades to its
 * query clip alone, which is how it behaved when it was first written, so a
 * regression here is invisible unless you read the policy.
 */

export type RecallProfileName = "lookup" | "standard" | "investigation";

export interface RecallProfile {
  name: RecallProfileName;
  /** Asked for, then clamped by policy. See the note above. */
  maxTokens: number;
  /** How much of the request text is used as the ranking query. */
  queryChars: number;
  /**
   * Episode cap to ask for, where a profile wants fewer than the policy
   * maximum. Undefined means "whatever the policy allows" — a profile can
   * only ever ask for fewer, never more.
   */
  limit?: number;
}

/**
 * Text at or above this length is treated as an investigation on length
 * alone. Chosen at roughly three sentences: below it, a request is a question;
 * above it, someone is describing a situation, and the description is where
 * the terms worth retrieving on live.
 */
const INVESTIGATION_CHARS = 280;

/**
 * Two or more entity references means a comparison or a history — "did #101
 * and #102 both come from the same change" — and one entity's worth of memory
 * will not answer it.
 */
const ENTITY_REFERENCES_FOR_INVESTIGATION = 2;

/**
 * Phrases that ask about the past or about causation rather than about state.
 *
 * Matched as substrings on lowercased text, so they catch inflections
 * ("regressed", "regression") without a stemmer. Kept to phrases that are
 * unambiguous in this product's traffic: "why" and "history" are the whole
 * point, whereas a generic "check" or "look at" is ordinary work.
 */
const INVESTIGATION_MARKERS = [
  "why ",
  "root cause",
  "investigat",
  "diagnos",
  "debug",
  "regress",
  "what changed",
  "what did we",
  "when did",
  "since when",
  "timeline",
  "history",
  "correlat",
  "compare",
  "audit",
  "postmortem",
  "post-mortem",
  "how did this",
  "who decided",
  "used to",
  "keeps happening",
  "again and again",
];

/**
 * Phrases that mean "read one small thing back to me".
 *
 * These are the personal-memory questions `remember_preference` exists to
 * answer, and they need the caller's own standing facts rather than a survey
 * of the corpus. Gated on brevity as well, because "do you remember what we
 * decided about the runner secrets, because the release is blocked and…" is
 * an investigation that happens to open with a recall phrase.
 */
const LOOKUP_MARKERS = [
  "do you remember",
  "what do i prefer",
  "what did i say",
  "my preference",
  "remind me",
  "what do you know about me",
  "forget about me",
  "what have you got on me",
];

/** Above this, a request is never a "lookup" however it is phrased. */
const LOOKUP_MAX_CHARS = 120;

const PROFILES: Record<RecallProfileName, Omit<RecallProfile, "name">> = {
  // Small on purpose. A standing-preference read wants the caller's own few
  // facts, not a pack; spending the full budget here buys context the answer
  // will not use and crowds the prompt on a turn that needed one sentence.
  lookup: { maxTokens: 600, queryChars: 200, limit: 4 },
  // The previous constants, kept as the middle case so the common turn's
  // behaviour is unchanged by this file.
  standard: { maxTokens: 1500, queryChars: 500 },
  // Both halves land under a 4000-token policy ceiling. The episode
  // count, not this number, is now usually what bounds the pack.
  investigation: { maxTokens: 4000, queryChars: 2000 },
};

/**
 * Classifies a request and returns the memory it is worth.
 *
 * Order matters: investigation is tested first, so a long request that opens
 * with "do you remember" is sized as the investigation it is rather than as
 * the lookup its first three words resemble.
 */
export function resolveRecallProfile(text: string): RecallProfile {
  const raw = text ?? "";
  const lower = raw.toLowerCase();

  if (isInvestigation(raw, lower)) return { name: "investigation", ...PROFILES.investigation };
  if (isLookup(raw, lower)) return { name: "lookup", ...PROFILES.lookup };
  return { name: "standard", ...PROFILES.standard };
}

function isInvestigation(raw: string, lower: string): boolean {
  if (raw.trim().length >= INVESTIGATION_CHARS) return true;
  if (INVESTIGATION_MARKERS.some((marker) => lower.includes(marker))) return true;
  return countEntityReferences(raw) >= ENTITY_REFERENCES_FOR_INVESTIGATION;
}

function isLookup(raw: string, lower: string): boolean {
  if (raw.trim().length > LOOKUP_MAX_CHARS) return false;
  return LOOKUP_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Counts distinct `#123`-style references. Distinct rather than total, so
 * "#101 #101 #101" is one subject and not a comparison.
 */
function countEntityReferences(text: string): number {
  const matches = text.match(/#\d+/g);
  if (!matches) return 0;
  return new Set(matches).size;
}
