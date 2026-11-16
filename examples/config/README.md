# Example configuration

These files are where you tell Lexi about your team: who may ask it to do what, which
repositories it works in, who owns which part of the product, what it remembers, and how
far its agents may go. They describe a fictional organisation, "Acme", so you can read
a complete setup before writing your own.

Lexi reads every file here from the directory named by `GOVERNANCE_CONFIG_DIR` (default
`./config`). The test suite runs against this directory.

To start your own deployment, copy this directory, point `GOVERNANCE_CONFIG_DIR`
at the copy, and replace the people, channels and repositories with your own.

| File | What it controls |
|---|---|
| `repos.yaml` | Which repositories the agent knows, and what it may do in each (issues, code, specs) |
| `ownership.yaml` | Which person in charge an issue is routed to, by module and platform |
| `people-overrides.yaml` | How GitHub logins map to Slack IDs and managers |
| `quick-fix-owners.yaml` | Who reviews, announces and is tagged on agent-made fixes |
| `escalation-policy.yaml` | How an untouched issue climbs from its owner to governance |
| `spec-policy.yaml` | How the spec interview runs and which specs need a second approver |
| `memory-policy.yaml` | What the agent remembers, for how long, and who can recall it |
| `authorization.yaml` | Roles, what each may ask the agent to do, and who holds them |
| `feature-policy.yaml` | What each kind of work item (bug, feature, chore, spec) needs before dispatch |
| `intake-policy.yaml` | When a submitted bug is rejected automatically and when a person reviews it |
| `duplicate-policy.yaml` | Similarity thresholds for closing duplicates or sending them to review |
| `reproduction-policy.yaml` | When an issue nobody could reproduce is marked, and later closed |
| `run-budgets.yaml` | How much one automation run may change before it stops |
| `severity-priority.yaml` | Rules that turn extracted facts into a severity and a priority |
| `autofix-policy.yaml` | Which issues an agent may open a fix pull request for, and how large it may be |
| `programme-policy.yaml` | Which repositories may run a rebuild programme, the build model ladder, milestone review and the auto-merge gate (off here) |

Every ID in these files (`U0TEST01`, `C0TEST01`, `acme/web-app`) is a placeholder.
