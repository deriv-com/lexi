/**
 * Workflows Lexi may never dispatch.
 *
 * Release and production pipelines ship code to users. Lexi opens branches and
 * pull requests; it does not cut releases, and it does not push builds to a
 * store. Dispatching one of these is a human act.
 *
 * WHY HERE AND NOT IN GOVERNANCE
 *
 * `@lexi/governance` already depends on `@lexi/github`, so the deny list cannot
 * live there without a dependency cycle. It sits next to the gateway instead —
 * which is also the better place, because the gateway's `dispatchWorkflow` is
 * the single choke point every caller passes through. A check here holds for
 * the Slack tools, the background services and the schedulers alike, without
 * each having to remember.
 *
 * It intentionally duplicates the *intent* of the protected-path rules in
 * `packages/governance/src/blast-radius/protected-paths.ts`. The two lists are
 * separate because they answer different questions — "may this file be edited"
 * versus "may this workflow be run" — and a file can be one without the other.
 */

/** Why a dispatch was refused, so the message can be specific. */
export interface ProtectedWorkflowVerdict {
  readonly blocked: boolean;
  readonly reason?: string;
}

/**
 * Matched against the workflow FILE name, case-insensitively, after any
 * directory prefix is stripped — callers pass `release.yml` and
 * `.github/workflows/release.yml` interchangeably.
 */
const BLOCKED_WORKFLOWS: ReadonlyArray<{ test: RegExp; reason: string }> = [
  {
    test: /^release\.ya?ml$/i,
    reason: "a release pipeline",
  },
  {
    test: /^production\.ya?ml$/i,
    reason: "a production pipeline",
  },
  // `production_build.yml`, `production-deploy.yml`, `production.tf.yml`.
  // The store build these named is no longer reachable at all — the Branch
  // Manager was removed — but the rule stays: it is the floor, not a patch for
  // one tool.
  {
    test: /^production[-_.].*\.ya?ml$/i,
    reason: "a production pipeline",
  },
  // Anything under a release/ or production/ workflow directory.
  {
    test: /^(release|production)\//i,
    reason: "a file inside a release or production pipeline directory",
  },
  // Publishing a package to a registry ships code to users the same way a
  // release does. `acme/design-system` carries `publish.yml` and
  // `publish-blocks.yml`; `acme-internal/mobile-packages` carries a literal
  // `release.yml`, already covered above.
  {
    test: /^publish([-_.].*)?\.ya?ml$/i,
    reason: "a package publish pipeline",
  },
];

/** Strips `.github/workflows/` and any other directory prefix. */
export function normalizeWorkflowFile(workflowFile: string): string {
  const trimmed = workflowFile.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  const withoutWorkflowDir = trimmed.replace(/^\.github\/workflows\//i, "");
  return withoutWorkflowDir;
}

/**
 * Classifies a workflow file.
 *
 * NOT blocked, and deliberately so:
 *   `release-integration.yml`      the working-branch integration run
 *   `common-release-integration.yml`
 *   `release-prepare-tag.yml`      prepares a tag issue; ships nothing
 *   `staging_build.yml`            staging is not production
 *
 * The hyphen/underscore boundary is what separates these from the blocked set:
 * `release-integration` is a different pipeline from `release`, and the check
 * is anchored so it cannot blur them.
 */
export function classifyWorkflowDispatch(workflowFile: string): ProtectedWorkflowVerdict {
  const name = normalizeWorkflowFile(workflowFile);
  if (!name) return { blocked: false };

  for (const rule of BLOCKED_WORKFLOWS) {
    if (rule.test.test(name)) {
      return { blocked: true, reason: rule.reason };
    }
  }
  return { blocked: false };
}

/** Convenience predicate. */
export function isProtectedWorkflow(workflowFile: string): boolean {
  return classifyWorkflowDispatch(workflowFile).blocked;
}

/** Refusal text. Ends by stating that nothing ran. */
export function describeProtectedWorkflowRefusal(workflowFile: string, owner: string, repo: string): string {
  const name = normalizeWorkflowFile(workflowFile);
  const verdict = classifyWorkflowDispatch(workflowFile);
  return (
    `Refusing to dispatch "${name}" on ${owner}/${repo}: it is ${verdict.reason ?? "a protected workflow"}, ` +
    `and running it is a human decision. Nothing was dispatched.`
  );
}
