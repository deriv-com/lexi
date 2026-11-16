/**
 * LexiCapabilityRegistry — authoritative self-knowledge.
 *
 * Lexi can answer accurately:
 * - "Can you update Projects?"
 * - "Is semantic search active?"
 * - "Are writes enabled?"
 * - "Can you verify KYC flows?"
 * - "What is degraded right now?"
 *
 * This eliminates stale capability statements. The registry is populated
 * from runtime configuration and live health checks, not from static text.
 */

export type CapabilityStatus = "available" | "disabled" | "degraded" | "external_pending";

export interface LexiCapability {
  id: string;
  name: string;
  description: string;
  status: CapabilityStatus;
  /** Why this status (e.g., "PROJECTS_V2_ENABLED=false" or "pgvector not connected"). */
  reason: string;
  /** Feature flag that controls this capability (if any). */
  featureFlag?: string;
  /** External dependency needed (if status is external_pending). */
  externalDependency?: string;
  /** When the status was last checked. */
  lastCheckedAt: string;
}

export interface CapabilityQuery {
  /** Natural language question about capability. */
  question: string;
  /** Inferred capability IDs from the question. */
  matchedCapabilities: string[];
}

/**
 * Authoritative runtime capability registry.
 */
export class LexiCapabilityRegistry {
  private capabilities = new Map<string, LexiCapability>();

  /**
   * Register a capability with its current status.
   */
  register(capability: LexiCapability): void {
    this.capabilities.set(capability.id, capability);
  }

  /**
   * Update a capability's status (e.g., after a health check).
   */
  updateStatus(id: string, status: CapabilityStatus, reason: string): void {
    const cap = this.capabilities.get(id);
    if (cap) {
      cap.status = status;
      cap.reason = reason;
      cap.lastCheckedAt = new Date().toISOString();
    }
  }

  /**
   * Get a capability by ID.
   */
  get(id: string): LexiCapability | undefined {
    return this.capabilities.get(id);
  }

  /**
   * Get all capabilities.
   */
  getAll(): LexiCapability[] {
    return [...this.capabilities.values()];
  }

  /**
   * Get capabilities by status.
   */
  getByStatus(status: CapabilityStatus): LexiCapability[] {
    return [...this.capabilities.values()].filter((c) => c.status === status);
  }

  /**
   * Words of 4+ characters, punctuation stripped. Stripping matters: splitting
   * "Find duplicates by meaning, not just keyword overlap." on whitespace alone
   * yields "meaning," and "overlap." with the punctuation attached, so a
   * question containing "meaning" would never match them.
   */
  private static tokens(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4);
  }

  /**
   * Answer: "Can you do X?" — match a natural language question to
   * capabilities, most relevant first.
   */
  queryCapability(question: string): {
    answer: string;
    matched: LexiCapability[];
    confidence: "high" | "medium" | "low";
  } {
    const lower = question.toLowerCase();

    // Matching is intentionally broad (any word of 4+ characters), but the
    // RESULT ORDER used to be Map insertion order, which meant the first
    // capability registered that happened to share one word with the question
    // led the answer. A capability whose description merely contains "search"
    // would outrank "Semantic Duplicate Search" for "is semantic duplicate
    // search active?" purely by being registered earlier. Since this backs the
    // `get_capabilities` tool, that put an irrelevant capability at the top of
    // Lexi's answer about what it can do.
    //
    // Scoring keeps the same permissive match rule but orders by how much of
    // the capability actually corresponds to the question: name and id hits
    // weigh more than description hits, because a name is what the capability
    // *is* while a description merely mentions things. Ties keep registration
    // order, so equally-relevant results stay stable and predictable.
    const scored: Array<{ cap: LexiCapability; score: number; order: number }> = [];
    let order = 0;

    for (const cap of this.capabilities.values()) {
      const nameTokens = LexiCapabilityRegistry.tokens(cap.name);
      const descTokens = LexiCapabilityRegistry.tokens(cap.description);
      const id = cap.id.toLowerCase();

      let score = 0;
      for (const token of nameTokens) if (lower.includes(token)) score += 3;
      for (const token of descTokens) if (lower.includes(token)) score += 1;
      if (id.length >= 4 && lower.includes(id)) score += 3;

      if (score > 0) {
        scored.push({ cap, score, order: order++ });
      }
    }

    scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
    const matched: LexiCapability[] = scored.map((s) => s.cap);

    if (matched.length === 0) {
      return {
        answer: "I don't have a registered capability matching that question. I may still be able to help — can you be more specific?",
        matched: [],
        confidence: "low",
      };
    }

    const answers = matched.map((cap) => {
      switch (cap.status) {
        case "available":
          return `✅ *${cap.name}*: Available. ${cap.description}`;
        case "disabled":
          return `⛔ *${cap.name}*: Disabled. ${cap.reason}`;
        case "degraded":
          return `⚠️ *${cap.name}*: Degraded. ${cap.reason}`;
        case "external_pending":
          return `🔒 *${cap.name}*: Pending external configuration. ${cap.reason}`;
      }
    });

    return {
      answer: answers.join("\n"),
      matched,
      confidence: matched.length === 1 ? "high" : "medium",
    };
  }

  /**
   * Get a summary of current system health for Lexi to report.
   */
  getHealthSummary(): string {
    const all = this.getAll();
    const available = all.filter((c) => c.status === "available").length;
    const disabled = all.filter((c) => c.status === "disabled").length;
    const degraded = all.filter((c) => c.status === "degraded").length;
    const pending = all.filter((c) => c.status === "external_pending").length;

    const lines: string[] = [];
    lines.push(`📋 *Lexi Capability Status*`);
    lines.push(`✅ Available: ${available} | ⛔ Disabled: ${disabled} | ⚠️ Degraded: ${degraded} | 🔒 Pending: ${pending}`);

    if (degraded > 0) {
      lines.push(``);
      lines.push(`*Degraded:*`);
      for (const cap of this.getByStatus("degraded")) {
        lines.push(`• ${cap.name}: ${cap.reason}`);
      }
    }

    if (pending > 0) {
      lines.push(``);
      lines.push(`*Pending external config:*`);
      for (const cap of this.getByStatus("external_pending")) {
        lines.push(`• ${cap.name}: ${cap.externalDependency ?? cap.reason}`);
      }
    }

    return lines.join("\n");
  }
}

/**
 * Build the capability registry from runtime configuration.
 */
export function buildCapabilityRegistry(config: {
  writesEnabled: boolean;
  semanticDuplicateEnabled: boolean;
  llmAdjudicationEnabled: boolean;
  humanAdjudicationEnabled: boolean;
  closedIssueSemanticsEnabled: boolean;
  projectsEnabled: boolean;
  projectsWritesEnabled: boolean;
  evidencePipelineEnabled: boolean;
  slackAgentEnabled: boolean;
  batchEnabled: boolean;
}): LexiCapabilityRegistry {
  const registry = new LexiCapabilityRegistry();
  const now = new Date().toISOString();

  // Deliberately describes WHO performs these writes, not just that they are
  // possible. This registry backs the `get_capabilities` tool, i.e. it is how
  // Lexi answers "can you close this issue?" — and the honest answer is that
  // Lexi itself has no tool that comments, labels, assigns, or closes. It
  // starts the pipeline; the deterministic WorkflowOrchestrator performs those
  // mutations after policy evaluation. The previous wording described the
  // provider's surface as though it were the agent's, which invited Lexi to
  // claim a capability it does not directly hold.
  registry.register({
    id: "github_writes",
    name: "GitHub Writes (via the governed pipeline)",
    description:
      "Create issues, close issues, add comments, manage labels, assign owners. Performed by the workflow pipeline after policy evaluation — not directly callable by the agent, which can only start the pipeline.",
    status: config.writesEnabled ? "available" : "disabled",
    reason: config.writesEnabled ? "GOVERNED_WRITES_ENABLED=true" : "GOVERNED_WRITES_ENABLED=false (shadow mode)",
    featureFlag: "GOVERNED_WRITES_ENABLED",
    lastCheckedAt: now,
  });

  // Read-only, so intentionally not gated on GOVERNED_WRITES_ENABLED: these
  // remain available in shadow mode, which is when verifying a claim against
  // the code matters most.
  registry.register({
    id: "code_reads",
    name: "Source Code and Diff Reads",
    description:
      "Search a product repo's code, read a file's current contents, and list the files and diffs a pull request changed — so a claim about what the code does can be checked against the code instead of taken on trust.",
    status: "available",
    reason: "Read-only; backed by the GitHub App's Contents:read permission.",
    lastCheckedAt: now,
  });

  // Distinct from github_writes because the blast radius differs: opening a PR
  // targets a product repo (web-app / mobile-app), not the issue
  // tracker. Stated explicitly because "can you merge it?" is the obvious
  // follow-up question and the answer is a flat no — no merge capability
  // exists anywhere in the provider, by design, so this must never be
  // described in a way that implies one.
  registry.register({
    id: "pull_request_create",
    name: "Open Pull Requests",
    description:
      "Open a pull request in a product repo from a branch that already exists. Creating a missing branch is create_branch. Merging is merge_pull_request, which needs the pr.merge permission — do not assume who holds it, the call is authorized against the current caller.",
    status: config.writesEnabled ? "available" : "disabled",
    reason: config.writesEnabled
      ? "Requires the pr.create permission (engineer and above)."
      : "GOVERNED_WRITES_ENABLED=false (shadow mode)",
    featureFlag: "GOVERNED_WRITES_ENABLED",
    lastCheckedAt: now,
  });

  registry.register({
    id: "semantic_duplicate_search",
    name: "Semantic Duplicate Search",
    description: "Find duplicates by meaning, not just keyword overlap.",
    status: config.semanticDuplicateEnabled ? "available" : "external_pending",
    reason: config.semanticDuplicateEnabled ? "pgvector active" : "Requires pgvector + EMBEDDING_API_KEY",
    featureFlag: "DUPLICATE_SEMANTIC_ENABLED",
    externalDependency: "pgvector PostgreSQL extension + embedding API credentials",
    lastCheckedAt: now,
  });

  registry.register({
    id: "llm_duplicate_adjudication",
    name: "LLM Duplicate Adjudication",
    description: "Use AI to determine if issues are true duplicates.",
    status: config.llmAdjudicationEnabled ? "available" : "disabled",
    reason: config.llmAdjudicationEnabled ? "Active" : "DUPLICATE_LLM_ADJUDICATION_ENABLED=false",
    featureFlag: "DUPLICATE_LLM_ADJUDICATION_ENABLED",
    lastCheckedAt: now,
  });

  registry.register({
    id: "human_adjudication",
    name: "Human Adjudication (Slack)",
    description: "Request human review for medium-confidence duplicates.",
    status: config.humanAdjudicationEnabled ? "available" : "disabled",
    reason: config.humanAdjudicationEnabled ? "Active" : "DUPLICATE_HUMAN_ADJUDICATION_ENABLED=false",
    featureFlag: "DUPLICATE_HUMAN_ADJUDICATION_ENABLED",
    lastCheckedAt: now,
  });

  registry.register({
    id: "closed_issue_semantics",
    name: "Closed-Issue Semantics",
    description: "Reopen not-observed, detect regressions, resolve canonical chains.",
    status: config.closedIssueSemanticsEnabled ? "available" : "disabled",
    reason: config.closedIssueSemanticsEnabled ? "Active" : "CLOSED_ISSUE_SEMANTICS_ENABLED=false",
    featureFlag: "CLOSED_ISSUE_SEMANTICS_ENABLED",
    lastCheckedAt: now,
  });

  registry.register({
    id: "github_projects",
    name: "GitHub Projects v2",
    description: "Read/write GitHub project boards, manage issue placement and status.",
    status: config.projectsEnabled ? (config.projectsWritesEnabled ? "available" : "degraded") : "external_pending",
    reason: config.projectsEnabled
      ? (config.projectsWritesEnabled ? "Full read/write" : "Read-only (writes disabled)")
      : "Requires GitHub App with project:write scope",
    featureFlag: "PROJECTS_V2_ENABLED",
    externalDependency: "GitHub App with project:write scope + project number config",
    lastCheckedAt: now,
  });

  registry.register({
    id: "evidence_pipeline",
    name: "Evidence-First Pipeline",
    description: "5-stage assessment before reproduction: analysis, evidence, investigation, fix, necessity.",
    status: config.evidencePipelineEnabled ? "available" : "disabled",
    reason: config.evidencePipelineEnabled ? "Active" : "EVIDENCE_PIPELINE_ENABLED=false",
    featureFlag: "EVIDENCE_PIPELINE_ENABLED",
    lastCheckedAt: now,
  });

  registry.register({
    id: "slack_agent",
    name: "Slack Conversational Agent",
    description: "Multi-turn conversation, tool use, governed actions in Slack.",
    status: config.slackAgentEnabled ? "available" : "disabled",
    reason: config.slackAgentEnabled ? "Active" : "SLACK_AGENT_ENABLED=false",
    featureFlag: "SLACK_AGENT_ENABLED",
    lastCheckedAt: now,
  });

  registry.register({
    id: "batch_operations",
    name: "Batch Operations",
    description: "Process/reprocess multiple issues in a governed batch plan.",
    status: config.batchEnabled ? "available" : "disabled",
    reason: config.batchEnabled ? "Active" : "AGENT_BATCH_ENABLED=false",
    featureFlag: "AGENT_BATCH_ENABLED",
    lastCheckedAt: now,
  });

  return registry;
}
