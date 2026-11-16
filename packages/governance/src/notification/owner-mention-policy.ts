export interface OwnerMentionInput {
  enabled: boolean;
  githubLogin?: string;
  slackId?: string;
  ownershipConfidence: number;
  minConfidence: number;
  isFallbackOwner: boolean;
  teamScopeMatch: boolean;
}

export interface OwnerMentionDecision {
  mentionIndividual: boolean;
  mentionText?: string; // `<@SLACK_ID>` or team name
  reason: string;
}

/**
 * Only mention an individual owner when ALL conditions are met.
 * Otherwise fall back to team-level notification.
 */
export function evaluateOwnerMention(input: OwnerMentionInput, teamChannel?: string): OwnerMentionDecision {
  if (!input.enabled) {
    return { mentionIndividual: false, mentionText: teamChannel, reason: "Owner mentions disabled (AGENT_OWNER_MENTIONS_ENABLED=false)." };
  }

  if (!input.slackId) {
    return { mentionIndividual: false, mentionText: teamChannel, reason: "Owner Slack ID not resolved — notifying team channel instead." };
  }

  if (input.isFallbackOwner) {
    return { mentionIndividual: false, mentionText: teamChannel, reason: "Owner is a fallback/default assignment — notifying team channel instead." };
  }

  if (input.ownershipConfidence < input.minConfidence) {
    return { mentionIndividual: false, mentionText: teamChannel, reason: `Ownership confidence ${input.ownershipConfidence} is below threshold ${input.minConfidence} — notifying team channel instead.` };
  }

  if (!input.teamScopeMatch) {
    return { mentionIndividual: false, mentionText: teamChannel, reason: "Issue is outside the owner's configured team scope — notifying team channel instead." };
  }

  return {
    mentionIndividual: true,
    mentionText: `<@${input.slackId}>`,
    reason: "Owner verified, confidence sufficient, scope matches.",
  };
}
