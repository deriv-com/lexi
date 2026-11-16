# Capability matrix

<!-- Generated. Do not edit by hand: change the tools or the policy and run
     `npm run docs:capability-matrix`. A spec fails when this file is stale. -->

Everything the agent can do is a tool in a tool module. This page lists every tool the
default modules register, whether it changes anything, and the permission the person
asking must hold. The tool registry checks that permission before the tool runs, against
the person who asked rather than anything the model says, and refuses when it cannot decide.

**9 modules, 51 tools: 30 change something outside the agent, 21 do not.**

Permissions are checked against `examples/config/authorization.yaml`.

## Modules

| Module | Offered for | Tools | Changing |
|--------|-------------|-------|----------|
| `github-read` | every request | 8 | 0 |
| `github-write` | every request | 8 | 8 |
| `agent-fix` | `bug_intake`, `code_task`, `issue_query`, `delivery` | 3 | 2 |
| `work-items` | every request | 2 | 1 |
| `slack` | every request | 2 | 1 |
| `memory` | every request | 6 | 0 |
| `spec` | `spec`, `work_item` | 5 | 4 |
| `app-build` | `code_task`, `delivery` | 4 | 3 |
| `programme` | `work_item`, `spec`, `code_task`, `delivery` | 13 | 11 |

## Tools that change something outside the agent

| Tool | Module | Required permission |
|------|--------|---------------------|
| `add_milestones` | `programme` | `programme.programme.create` |
| `cancel_build_tasks` | `programme` | `programme.task.cancel` |
| `cancel_programme` | `programme` | `programme.programme.cancel` |
| `close_issue` | `github-write` | `issue.close` |
| `close_pull_request` | `github-write` | `pr.close` |
| `comment_on_issue` | `github-write` | `issue.comment` |
| `create_branch` | `github-write` | `branch.create` |
| `create_issue` | `work-items` | `work_item.create` |
| `create_pull_request` | `github-write` | `pr.create` |
| `create_spec_tasks` | `spec` | `work_item.create` |
| `dispatch_agent_fix` | `agent-fix` | `code_task.trigger` |
| `merge_pull_request` | `github-write` | `pr.merge` |
| `pause_programme` | `programme` | `programme.pause` |
| `post_to_channel` | `slack` | `slack.post_channel` |
| `propose_milestone_plan` | `programme` | `programme.task.dispatch` |
| `rebase_branch` | `agent-fix` | `branch.rebase` |
| `record_programme_decision` | `programme` | `programme.decision.record` |
| `reopen_issue` | `github-write` | `issue.close` |
| `reopen_pull_request` | `github-write` | `pr.close` |
| `resume_programme` | `programme` | `programme.pause` |
| `retry_build_task` | `programme` | `programme.task.retry` |
| `send_app_build_feedback` | `app-build` | `app_build.feedback` |
| `set_task_criteria` | `programme` | `programme.task.rescope` |
| `start_app_build` | `app-build` | `app_build.trigger` |
| `start_app_rebuild` | `programme` | `programme.programme.create` |
| `start_model_bench` | `programme` | `programme.task.dispatch` |
| `start_spec_session` | `spec` | `spec.create` |
| `stop_app_build` | `app-build` | `app_build.stop` |
| `submit_spec_for_review` | `spec` | `spec.submit_review` |
| `update_spec_draft` | `spec` | `spec.revise` |

## Tools that change nothing outside the agent

These read, or write only to the agent's own memory. A permission here still gates the call.

| Tool | Module | Required permission |
|------|--------|---------------------|
| `forget_about_me` | `memory` | `memory.remember` |
| `forget_team_convention` | `memory` | `memory.forget_team` |
| `generate_task_breakdown` | `spec` | `work_item.create` |
| `get_agent_run_result` | `agent-fix` | `issue.read` |
| `get_app_build_status` | `app-build` | `actions.read` |
| `get_file` | `github-read` | `issue.read` |
| `get_issue` | `github-read` | `issue.read` |
| `get_programme_status` | `programme` | `programme.read` |
| `get_pull_request` | `github-read` | `issue.read` |
| `get_thread_context` | `slack` | `issue.read` |
| `get_workflow_logs` | `github-read` | `issue.read` |
| `get_workflow_run` | `github-read` | `issue.read` |
| `list_pull_requests` | `github-read` | `issue.read` |
| `list_repositories` | `work-items` | `issue.read` |
| `list_workflow_runs` | `github-read` | `issue.read` |
| `prepare_technical_spec` | `programme` | `programme.read` |
| `recall_memory` | `memory` | `memory.recall` |
| `remember_preference` | `memory` | `memory.remember` |
| `remember_team_convention` | `memory` | `memory.remember` |
| `search_issues` | `github-read` | `issue.read` |
| `search_product_knowledge` | `memory` | `issue.read` |

## Action classes

Every mutation carries an action class that decides how it is executed. An action the
classifier does not know is treated as `human_gated`.

| Action | Class | Confirmation | Grace period |
|--------|-------|--------------|--------------|
| `assign` | constructive | — | — |
| `branch.delete` | human_gated | required | — |
| `branch.rebase` | human_gated | required | — |
| `bulk_close` | human_gated | required | — |
| `close.denylist` | human_gated | required | — |
| `close.direct_ai` | prohibited | — | — |
| `close.duplicate` | delayed_reversible | — | 3d |
| `close.fixed` | delayed_reversible | — | 1d |
| `close.not_observed` | delayed_reversible | — | 7d |
| `comment.add` | constructive | — | — |
| `issue.create` | constructive | — | — |
| `issue.update` | constructive | — | — |
| `label.add` | constructive | — | — |
| `label.remove` | constructive | — | — |
| `merge` | prohibited | — | — |
| `notification.send` | constructive | — | — |
| `ownership.remove` | human_gated | required | — |
| `priority.lower` | human_gated | required | — |
| `pull_request.close` | prohibited | — | — |
| `pull_request.merge` | prohibited | — | — |
| `security.mutate` | prohibited | — | — |
| `severity.lower` | human_gated | required | — |
| `spec.approve` | human_gated | required | — |
| `spec.create` | constructive | — | — |
| `spec.revise` | constructive | — | — |
| `spec.submit_review` | constructive | — | — |
| `spec.supersede` | human_gated | required | — |
| `stale_bugfix.pull_request.close` | delayed_reversible | — | 20h |
| `work_item.create` | constructive | — | — |
