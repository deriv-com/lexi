import { describe, it, expect } from "vitest";
import { parseProductSpec, seedSessionFromProductSpec } from "./product-spec";
import { parseAcceptanceCriteria } from "./task-candidates";

/**
 * A fictional product spec in the document shape the parser is written for, with one
 * domain in full and a second stub so cross-domain selection is exercised.
 */
const SPEC = [
  "# Acme App — Product Specification",
  "",
  "## Decision log",
  "",
  "| ID | Decision |",
  "|---|---|",
  "| `D-02` | The wallet is created when real-account creation completes and holds no currency until the first deposit. |",
  "",
  "# PART 1 — CONSOLIDATED PRODUCT SPECIFICATION",
  "",
  "## 3. Product Domains",
  "",
  "### D1 — Identity & Access",
  "",
  "#### Overview",
  "",
  "Establishes and maintains a user's authenticated session.",
  "",
  "#### User Journeys",
  "",
  "| # | Journey |",
  "|---|---|",
  "| J1.1 | Sign in with an identifier and password |",
  "| J1.2 | Sign in with a one-time code instead of a password |",
  "",
  "#### Preconditions",
  "",
  "- J1.1–J1.2: none — these are public journeys.",
  "",
  "#### Product Behaviour",
  "",
  "**Identifier-first sign-in.** Sign-in collects the identifier first, then the credential on a separate step.",
  "",
  "**Routing after the identifier.** Once the identifier is submitted, the product determines the next step:",
  "",
  "| Determination | Outcome |",
  "|---|---|",
  "| Account exists and holds a password | The password step is presented. |",
  "| No account exists for the identifier | A \"no account found\" prompt inviting the user to sign up. |",
  "",
  "**Two-factor challenge.** Where two-factor authentication is enabled, the first factor does not issue a full session. `D-09` Backup codes are available on **both interfaces**.",
  "",
  "#### Business Rules",
  "",
  "| ID | Rule |",
  "|---|---|",
  "| BR-1.1 | An account without a password credential is never blocked from signing in; it is routed to one-time-code sign-in. |",
  "| BR-1.2 | An inconclusive credential-type determination falls back to the password step (PWR-15). |",
  "",
  "#### States",
  "",
  "| State | Behaviour |",
  "|---|---|",
  "| Loading | The credential step is not shown until the identifier determination resolves. |",
  "",
  "#### Validation Rules",
  "",
  "| Field | Rule |",
  "|---|---|",
  "| Identifier — email | Must be a well-formed email address. Message: *\"Please enter a valid email address.\"* |",
  "",
  "#### Error Behaviour",
  "",
  "- Credential failures are inline against the step; the user is not navigated away.",
  "- Rate limiting states the remaining wait rather than silently refusing.",
  "",
  "#### Platform Differences",
  "",
  "| Behaviour | Rationale |",
  "|---|---|",
  "| Biometric unlock is mobile-only. | Depends on a device sensor. **Intentional platform-specific requirement.** |",
  "| ~~Two-factor backup codes~~ | **Resolved** `D-09` — backup codes exist on both interfaces. No longer a platform difference. |",
  "",
  "#### Dependencies",
  "",
  "D2 (signup and migration routing), D3 (credential and second-factor management).",
  "",
  "#### Open Questions",
  "",
  "Q-1, Q-6.",
  "",
  "---",
  "",
  "### D2 — Registration & Onboarding",
  "",
  "#### Overview",
  "",
  "Creates the account.",
  "",
  "#### User Journeys",
  "",
  "| # | Journey |",
  "|---|---|",
  "| J2.1 | Register with an email or phone |",
  "",
  "#### Product Behaviour",
  "",
  "**Steps.** The full set, subject to jurisdiction:",
  "",
  "| Step | Behaviour |",
  "|---|---|",
  "| Phone number | Skippable — choosing to supply it later advances the sequence. |",
  "| ~~Wallet currency~~ | **Removed by D-02.** The user is not asked to choose a wallet currency during onboarding. |",
  "",
  "#### Open Questions",
  "",
  "Q-9.",
  "",
  "# PART 3 — PRODUCT CLARIFICATIONS (ALL RESOLVED)",
  "",
  "## Question register",
  "",
  "| ID | Domain | Question | Why it is unresolved | Impact |",
  "|---|---|---|---|---|",
  "| ~~**Q-1**~~ | D1, D3 | ~~Should changing the account password end the session on both interfaces?~~ | **RESOLVED `D-23`.** Yes. | Applied. |",
  "| **Q-6** | D1 | Should a resend request inside the cooldown reuse the existing code, as on mobile? | Web specifies only that a countdown holds the control. | A user typing a code fails for no reason. |",
  "| **Q-9** | D2 | Should the demo-first starting choice exist on mobile? | Specified on web; absent on mobile. | Barrier to first use. |",
  "",
].join("\n");

describe("parseProductSpec", () => {
  it("finds every domain with its journeys, statements and questions", () => {
    const document = parseProductSpec(SPEC);
    expect(document.problems).toEqual([]);
    expect(document.domains.map((d) => `${d.id} ${d.title}`)).toEqual(["D1 Identity & Access", "D2 Registration & Onboarding"]);
    const d1 = document.domains[0]!;
    expect(d1.overview).toBe("Establishes and maintains a user's authenticated session.");
    expect(d1.journeys).toEqual([
      { id: "J1.1", text: "Sign in with an identifier and password" },
      { id: "J1.2", text: "Sign in with a one-time code instead of a password" },
    ]);
    expect(d1.openQuestions).toEqual(["Q-1", "Q-6"]);
    expect(d1.dependencies).toContain("D2 (signup and migration routing)");
  });

  it("turns behaviour paragraphs, decision-table rows, rules, states, validation and errors into statements", () => {
    const d1 = parseProductSpec(SPEC).domains[0]!;
    expect(d1.criterionTexts).toEqual([
      "Identifier-first sign-in: Sign-in collects the identifier first, then the credential on a separate step.",
      "Routing after the identifier: Once the identifier is submitted, the product determines the next step:",
      "Routing after the identifier — Account exists and holds a password: The password step is presented.",
      'Routing after the identifier — No account exists for the identifier: A "no account found" prompt inviting the user to sign up.',
      "Two-factor challenge: Where two-factor authentication is enabled, the first factor does not issue a full session. `D-09` Backup codes are available on both interfaces.",
      "BR-1.1: An account without a password credential is never blocked from signing in; it is routed to one-time-code sign-in.",
      "BR-1.2: An inconclusive credential-type determination falls back to the password step (PWR-15).",
      "State Loading: The credential step is not shown until the identifier determination resolves.",
      'Validation — Identifier — email: Must be a well-formed email address. Message: *"Please enter a valid email address."*',
      "Error behaviour: Credential failures are inline against the step; the user is not navigated away.",
      "Error behaviour: Rate limiting states the remaining wait rather than silently refusing.",
    ]);
    // Table furniture never becomes a statement.
    expect(d1.criterionTexts.some((text) => text.includes("---"))).toBe(false);
  });

  it("drops struck-through rows, keeping only removals as non-goals", () => {
    const document = parseProductSpec(SPEC);
    const [d1, d2] = document.domains;
    // Resolved parity question: struck, but it is a requirement elsewhere, so
    // it is neither a criterion nor a non-goal.
    expect(d1!.platformDifferences).toEqual(["Biometric unlock is mobile-only. — Depends on a device sensor. Intentional platform-specific requirement."]);
    expect(d1!.removed).toEqual([]);
    // Removed by the decision log: a non-goal.
    expect(d2!.removed).toEqual(["Wallet currency — Removed by D-02. The user is not asked to choose a wallet currency during onboarding."]);
    expect(d2!.criterionTexts).toEqual([
      "Steps: The full set, subject to jurisdiction:",
      "Steps — Phone number: Skippable — choosing to supply it later advances the sequence.",
    ]);
  });

  it("reads the question register and the decision log from outside the domains", () => {
    const document = parseProductSpec(SPEC);
    expect(document.questionRegister["Q-6"]).toBe("Should a resend request inside the cooldown reuse the existing code, as on mobile?");
    expect(document.questionRegister["Q-1"]).toBe("Should changing the account password end the session on both interfaces?");
    expect(document.decisionLog["D-02"]).toContain("The wallet is created when real-account creation completes");
  });
});

describe("seedSessionFromProductSpec", () => {
  it("seeds criteria that round-trip to the same AC ids the session will mint", () => {
    const { answers, criteria, unseeded } = seedSessionFromProductSpec(SPEC, { domains: ["d1"], platform: "web_ai" });
    expect(criteria).toHaveLength(11);
    const reparsed = parseAcceptanceCriteria(answers.acceptance_criteria?.answer);
    expect(reparsed.map((c) => c.id)).toEqual(criteria.map((c) => c.id));
    expect(reparsed.map((c) => c.text)).toEqual(criteria.map((c) => c.text));
    expect(answers.acceptance_criteria?.confidence).toBe(0.9);
    // What the business spec cannot say — and non_goals, because D1 alone
    // strikes nothing out as removed (its struck row is a resolved parity
    // question, which is a requirement elsewhere, not an exclusion).
    expect(unseeded).toEqual(["users", "non_goals", "rollout", "api_contract"]);
  });

  it("seeds problem, scope, journey_states, platforms, dependencies and risks from the domain", () => {
    const { answers } = seedSessionFromProductSpec(SPEC, { domains: ["D1"], platform: "web_ai" });
    expect(answers.problem?.answer).toBe("D1 Identity & Access: Establishes and maintains a user's authenticated session.");
    expect(answers.scope?.answer).toContain("- J1.1 Sign in with an identifier and password (D1)");
    expect(answers.journey_states?.answer).toContain("J1.2 Sign in with a one-time code");
    expect(answers.platforms?.answer).toContain("Rebuild target platform key: web_ai.");
    expect(answers.platforms?.answer).toContain("Biometric unlock is mobile-only.");
    expect(answers.dependencies?.answer).toBe("D1: D2 (signup and migration routing), D3 (credential and second-factor management).");
    // Open questions resolve to their register text, so a reader sees the
    // question, not just its id.
    expect(answers.risks?.answer).toContain("- Q-6: Should a resend request inside the cooldown reuse the existing code, as on mobile?");
    expect(answers.non_goals).toBeUndefined();
  });

  it("merges several domains and reports the ones the document lacks", () => {
    const result = seedSessionFromProductSpec(SPEC, { domains: ["D1", "D2", "D12"] });
    expect(result.unknownDomains).toEqual(["D12"]);
    expect(result.criteria).toHaveLength(13);
    expect(result.answers.scope?.answer).toContain("D1 Identity & Access, D2 Registration & Onboarding");
    expect(result.answers.non_goals?.answer).toContain("Wallet currency — Removed by D-02.");
    expect(result.answers.risks?.answer).toContain("- Q-9: Should the demo-first starting choice exist on mobile?");
  });

  it("seeds nothing and says so when no requested domain exists", () => {
    const result = seedSessionFromProductSpec(SPEC, { domains: ["D9"] });
    expect(result.criteria).toEqual([]);
    expect(result.unknownDomains).toEqual(["D9"]);
    expect(result.unseeded).toContain("acceptance_criteria");
  });
});
