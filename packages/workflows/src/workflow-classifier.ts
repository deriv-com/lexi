/**
 * Classifies which hands-on reproduction workflow an issue needs, so a
 * capability envelope (which workflows a reproduction provider may attempt,
 * and which it must never touch) can be applied to it.
 *
 * The vocabulary is the envelope's own two lists — supported plus denied —
 * rather than a hard-coded enum here. That way adding a workflow is a config
 * change, and the classifier can never return a name the policy has no opinion
 * about.
 *
 * Deliberately thin. It asks for one label and validates the answer against the
 * vocabulary; everything that decides what to *do* with the label lives with
 * the caller. A misclassification therefore cannot widen a provider's reach
 * beyond `supportedWorkflows`, only misroute within it.
 */

/** The two workflow lists a capability envelope declares. */
export interface WorkflowVocabularySource {
  /** Workflows the provider may attempt. */
  supportedWorkflows: readonly string[];
  /** Workflows the provider must never attempt. */
  denyWorkflows: readonly string[];
}

export interface WorkflowClassificationInput {
  issueNumber: number;
  title: string;
  body: string | null;
  labels: string[];
}

export interface WorkflowClassification {
  /** A name drawn from the config vocabulary, or null when unidentifiable. */
  workflow: string | null;
  /** Set when the model answered with something outside the vocabulary. */
  rejectedAnswer?: string;
  source: "llm" | "unavailable" | "invalid";
}

/** The single completion this needs. Kept narrow so any provider can satisfy it. */
export interface WorkflowClassifierPort {
  classify(prompt: string): Promise<string>;
}

export function workflowVocabulary(capabilities: WorkflowVocabularySource): string[] {
  return [...new Set([...capabilities.supportedWorkflows, ...capabilities.denyWorkflows])].map((w) =>
    w.trim().toLowerCase(),
  );
}

export function buildWorkflowClassificationPrompt(
  input: WorkflowClassificationInput,
  capabilities: WorkflowVocabularySource,
): string {
  const vocab = workflowVocabulary(capabilities);
  return [
    "You are classifying which hands-on reproduction workflow a bug report would require.",
    "",
    "Answer with EXACTLY ONE of these identifiers, and nothing else:",
    ...vocab.map((w) => `- ${w}`),
    "- unknown",
    "",
    "Guidance:",
    "- Choose the workflow a tester would have to perform to observe the reported behaviour.",
    "- selfie_capture covers liveness checks, face capture, and blink/smile prompts.",
    "- passkey_verification covers passkeys, WebAuthn, biometric unlock, and authenticator enrolment.",
    "- kyc_document_upload covers uploading or photographing identity documents.",
    "- payment_card_entry covers entering card or bank details.",
    "- money_movement covers deposits, withdrawals, and transfers.",
    "- otp_human_verification covers one-time codes and similar human verification gates.",
    "- exploratory_console covers ordinary UI and console inspection with no such gate.",
    '- Answer "unknown" if the report does not say enough to tell.',
    "",
    `Issue #${input.issueNumber}: ${input.title}`,
    `Labels: ${input.labels.join(", ") || "none"}`,
    "",
    (input.body ?? "").slice(0, 4000),
  ].join("\n");
}

/**
 * Normalises a model answer to a vocabulary entry.
 *
 * Anything unrecognised becomes null rather than being passed through, so a
 * hallucinated workflow cannot slip past a capability check — which should
 * fail closed on null and route to a human.
 */
export function parseWorkflowAnswer(
  answer: string,
  capabilities: WorkflowVocabularySource,
): WorkflowClassification {
  const cleaned = answer.trim().toLowerCase().replace(/[`"'.]/g, "");
  if (!cleaned || cleaned === "unknown") {
    return { workflow: null, source: cleaned ? "llm" : "invalid" };
  }
  const vocab = workflowVocabulary(capabilities);
  const exact = vocab.find((w) => w === cleaned);
  if (exact) return { workflow: exact, source: "llm" };
  // Models sometimes answer in a sentence. Accept a unique containment match,
  // but never a guess: two candidates means the answer was ambiguous.
  const contained = vocab.filter((w) => cleaned.includes(w));
  if (contained.length === 1) return { workflow: contained[0], source: "llm" };
  return { workflow: null, rejectedAnswer: answer.slice(0, 200), source: "invalid" };
}

/**
 * Classifies, never throws. A classifier outage yields `null`, which a
 * capability check should treat as "unclassified" and route to a human — the
 * safe direction, since the whole point of the gate is to keep an automated
 * provider away from flows it must not attempt.
 */
export async function classifyReproductionWorkflow(
  input: WorkflowClassificationInput,
  capabilities: WorkflowVocabularySource,
  port: WorkflowClassifierPort | undefined,
  onError?: (message: string) => void,
): Promise<WorkflowClassification> {
  if (!port) return { workflow: null, source: "unavailable" };
  try {
    const answer = await port.classify(buildWorkflowClassificationPrompt(input, capabilities));
    return parseWorkflowAnswer(answer, capabilities);
  } catch (err) {
    onError?.(err instanceof Error ? err.message : "unknown workflow classifier error");
    return { workflow: null, source: "unavailable" };
  }
}
