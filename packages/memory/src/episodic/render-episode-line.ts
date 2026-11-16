import type { MemoryEpisodeRecord } from "@lexi/contracts";

/**
 * One recalled episode as a line of the prompt's memory block.
 *
 * This exists for one reason: the model reads the rendered block, not the
 * record. `temporalStatus` can be perfectly correct on `MemoryEpisodeRecord`
 * and still not matter, because the block used to render every episode as
 * `- (kind) content` — so a rule that was retracted last week arrived in the
 * prompt looking exactly like the rule that replaced it, and the only thing
 * keeping the model from stating it as current was luck about ordering.
 *
 * A current episode renders byte-identically to before, deliberately: this
 * must change the historical case and nothing else, so the common turn's
 * memory block does not move and any behaviour change is attributable.
 *
 * Only the date is added, not the attribution. A date is what stops a
 * superseded fact being read in the present tense; `provenance.actor` and
 * `supersededById` stay on the record for a caller that needs to say who, and
 * putting them on every line would spend budget on most turns to serve a few.
 */
export function renderEpisodeLine(episode: MemoryEpisodeRecord): string {
  if (episode.temporalStatus !== "historical") return `- (${episode.kind}) ${episode.content}`;

  const since = isoDate(episode.supersededAt ?? episode.validUntil);
  const when = since ? ` since ${since}` : "";
  return `- (${episode.kind}, no longer current${when}) ${episode.content}`;
}

/** Date only. The time of day never changes how a stale fact should be read. */
function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}
