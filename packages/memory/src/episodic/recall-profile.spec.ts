import { describe, it, expect } from "vitest";
import { resolveRecallProfile } from "./recall-profile";

/**
 * Request-appropriate recall budgets.
 *
 * The agent recalled with two constants on every turn: `maxTokens: 1500` and
 * `input.text.slice(0, 500)`. The clip was the damaging one because it was
 * silent — a long investigation request was ranked against its opening
 * sentence, every term past character 500 never reached retrieval, and nothing
 * in the reply indicated that most of the question had not been used.
 *
 * The two properties that matter here are asymmetric, so both are tested:
 * a big request must be able to ask for more, and — the one that is easy to
 * lose — the ordinary turn must not quietly become the big request. Injecting
 * the whole store into every turn is the failure this file guards against as
 * much as under-recall.
 */
describe("resolveRecallProfile", () => {
  it("sizes an ordinary request exactly as the previous constants did", () => {
    // The middle case must be unchanged by this file, or every turn's memory
    // block moves at once and the change is unattributable.
    const profile = resolveRecallProfile("can you check the deposit button issue");
    expect(profile.name).toBe("standard");
    expect(profile.maxTokens).toBe(1500);
    expect(profile.queryChars).toBe(500);
    expect(profile.limit).toBeUndefined();
  });

  it("treats a long situational description as an investigation", () => {
    const long =
      "this regressed sometime after the third. we changed the release candidate branch naming " +
      "that week and also rotated the runner secrets, and the staging dispatch started recording " +
      "every check as skipped. what did we decide about the workdir input, and was that before or " +
      "after the auto-merge gate change?";
    expect(long.length).toBeGreaterThan(280);

    const profile = resolveRecallProfile(long);
    expect(profile.name).toBe("investigation");
    // The clip must actually cover the request, or the terms that identify the
    // subject are still discarded before ranking.
    expect(profile.queryChars).toBeGreaterThanOrEqual(long.length);
  });

  it("treats a short causal question as an investigation", () => {
    // Length is not the only signal: "why did the deposit fix regress" is 31
    // characters and is exactly the question memory exists to answer.
    for (const text of [
      "why did the deposit fix regress",
      "what changed in the runner config",
      "when did we stop using the slash form",
      "root cause for the skipped checks",
      "this keeps happening on staging",
      "we used to branch off develop",
    ]) {
      expect(resolveRecallProfile(text).name, text).toBe("investigation");
    }
  });

  it("treats two distinct entity references as a comparison", () => {
    expect(resolveRecallProfile("did #101 and #102 come from the same change").name).toBe("investigation");
    // One subject repeated is not a comparison.
    expect(resolveRecallProfile("look at #101 again, #101 is still open").name).toBe("standard");
  });

  it("sizes a personal-memory read small", () => {
    for (const text of [
      "what do i prefer for run links",
      "remind me what i said about quill",
      "do you remember my preference here",
    ]) {
      const profile = resolveRecallProfile(text);
      expect(profile.name, text).toBe("lookup");
      // Strictly smaller than the old constant in both dimensions: a standing
      // preference read wants the caller's few facts, not a pack.
      expect(profile.maxTokens).toBeLessThan(1500);
      expect(profile.queryChars).toBeLessThan(500);
      expect(profile.limit).toBe(4);
    }
  });

  it("does not mistake a long question that opens with a recall phrase for a lookup", () => {
    // "do you remember" is a lookup marker, but this is a question about the
    // work and not about the caller — sizing it at the lookup's 200-character
    // clip would discard most of it. Brevity is a required condition of
    // `lookup` for exactly this reason.
    const text =
      "do you remember what we decided about the runner secrets, because the release is blocked " +
      "and the dispatch has been failing since the naming change went in on the fourth";
    expect(text.length).toBeGreaterThan(120);

    const profile = resolveRecallProfile(text);
    expect(profile.name).not.toBe("lookup");
    expect(profile.queryChars).toBeGreaterThanOrEqual(text.length);
  });

  it("classifies a short question carrying both markers as an investigation", () => {
    // The ordering is deliberate: investigation is tested before lookup, so a
    // request that reads as both is sized as the larger of the two.
    const text = "do you remember why the deposit fix regressed";
    expect(text.length).toBeLessThan(120);
    expect(resolveRecallProfile(text).name).toBe("investigation");
  });

  it("never asks for less than it needs to rank the text it was given", () => {
    // The invariant behind the whole file: whatever profile is chosen, either
    // the clip covers the request or the request was classified as the large
    // case. A short text sized as a `lookup` must still be fully covered.
    for (const text of [
      "hi",
      "what do i prefer",
      "check the deposit button",
      "why did this regress",
      "a".repeat(3000),
    ]) {
      const profile = resolveRecallProfile(text);
      const covered = profile.queryChars >= text.length;
      expect(covered || profile.name === "investigation", `${profile.name}: ${text.slice(0, 40)}`).toBe(true);
    }
  });

  it("survives empty and whitespace input rather than throwing", () => {
    // `recallMemoryBlock` runs on every turn and must never be the reason a
    // turn fails; an empty mention is a real message shape.
    expect(resolveRecallProfile("").name).toBe("standard");
    expect(resolveRecallProfile("   ").name).toBe("standard");
    expect(resolveRecallProfile(undefined as unknown as string).name).toBe("standard");
  });
});
