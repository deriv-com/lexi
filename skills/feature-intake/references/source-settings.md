# Source settings

Fill this table in for your product when you copy the skill into a rebuild
repository. The values below are placeholders.

| Setting | Value |
|---|---|
| Live product | `https://app.example.com/dashboard` (staging: `https://staging.app.example.com`) |
| Rebuild repository | `acme/web-rebuild` |
| Build brief | `BUILD.md`: scope, and which source wins when sources conflict |
| Acceptance contract | `docs/acceptance.md`: devices, network conditions, accessibility and language checks |
| Business sources | `docs/spec/README.md`: objectives, positioning, product rules, features and journeys |
| API docs to compare against | `docs/api/README.md` and the payload shapes it links |
| Standards | `docs/standards/` (accessibility, performance, security, observability) |
| Design system | `docs/design-system/README.md` |
| Production code | `acme/web-app`, read-only, cloned into `reference/web-app/` when the workflow's `reference_repositories` input names it |
| Issue labels | `type:feature`, `platform:web` or `platform:mobile`, `needs-spec`, optional `needs-approval`, then `ready-for-agent` |

## Facts to keep in mind when comparing

List here what a capture agent would otherwise get wrong about your product:
which host serves identity and which serves the core API, path prefixes such as
`/v1`, endpoints that exist in the contract but are no longer used, and any bot
challenge the staging services require (record it and its request contract;
never assume a required challenge can be dropped).
