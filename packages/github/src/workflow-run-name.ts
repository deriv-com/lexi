/**
 * Match a `workflow_dispatch` run's GitHub `name` / `display_title` to a
 * caller-supplied token such as a QA run's `bill_id` (`ISSUE-1962`).
 *
 * qa-mobile.yml names runs `QA Mobile ISSUE-N · android · …`. Timing-only
 * correlation swaps those ids when two dispatches land seconds apart.
 */
export function workflowRunNameIncludes(runName: string, token: string): boolean {
  const needle = token.trim();
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(runName);
}

export function workflowRunDisplayName(run: {
  name?: string | null;
  display_title?: string | null;
}): string {
  return `${run.name ?? ""} ${run.display_title ?? ""}`.trim();
}
