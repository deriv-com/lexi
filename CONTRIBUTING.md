# Contributing to Lexi

Thanks for your interest in Lexi. Contributions from outside the project are welcome:
bug reports, documentation fixes, new tests, and code. Lexi is an early release, so some
of the layout below may still change; the issue tracker is the place to ask before you
build on something that looks unsettled.

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
Report security problems privately, as [SECURITY.md](SECURITY.md) describes, not in a
public issue.

## Getting set up

You need Node.js 20 or later (the repository pins 22 in `.nvmrc`) and npm. The
repository uses npm workspaces; there is no pnpm or yarn lockfile.

```bash
npm install
npm run prisma:generate   # generates the database client; the build needs it
npm run build             # tsc -b over every package
```

You do not need Slack, GitHub credentials, a model key or a database to build and test
Lexi. To run the server against a real workspace, follow
[getting started](docs/getting-started.md).

## Running the tests

Tests live next to the code as `*.spec.ts` (and `*.spec.mjs` in `apps/build` and
`scripts`), and run with Vitest.

```bash
npx vitest run packages/governance   # the specs for what you touched
npm test                             # every spec
npm run check                        # what CI runs
```

`npm run check` runs the TypeScript build, lint, tests, the leak scan and the licence
check. The app-build shell scripts have their own checks:

```bash
bash -n app-build/*.sh
python3 -m unittest discover -s app-build/tests
```

## Where to start

- **Documentation.** If a doc and the code disagree, the code is right and the doc needs a
  fix. Every doc in [`docs/`](docs) links the files it describes.
- **Example configuration.** [`examples/config`](examples/config/README.md) is also the
  test fixture. Clearer comments and better placeholder examples help every new reader.
- **Tests.** A spec that pins down a behaviour the docs promise is always useful.
- **Tool modules.** New agent tools live in [`packages/agent-tools`](packages/agent-tools).
  Read [adding a tool safely](docs/governance-model.md#adding-a-tool-safely) first.
- **Known gaps.** The [threat model](docs/threat-model.md#known-gaps) lists what is not
  mitigated yet. Open an issue to agree an approach before taking one on.

## Making a change

1. Open an issue first for anything larger than a small fix, so the approach can be agreed before you write code.
2. Branch from `main` and keep each pull request to one change.
3. Add or update tests for what you change. Tests live next to the code as `*.spec.ts`.
4. Run `npm run check` before you push.
5. Fill in the pull request description: what changed, why, and how you verified it.

After changing a tool module, regenerate the capability matrix with
`npm run docs:capability-matrix` and commit the result; a spec fails while it is stale.

## What makes a good pull request

- It does one thing, and its description says what, why, and how you checked it.
- It comes with tests, or says why a test is not possible.
- It keeps the docs true: if behaviour changes, the doc that describes it changes in the
  same pull request.
- It follows the design rules below, or makes the case for an exception.
- It uses placeholder values in examples and tests. The fictional organisation is "Acme",
  and Slack IDs look like `U0TEST01` or `C0TEST01`.

## Design rules

These hold across the codebase. A pull request that breaks one needs a strong reason in its description.

- **The model never writes directly.** Every write to GitHub, Slack or the database goes through deterministic code that checks authorization and policy first.
- **Authorization fails closed.** A missing role, an unknown action or an unreadable policy file means "denied", never "allowed".
- **External systems sit behind interfaces.** GitHub, Slack, the LLM and the database are reached through adapter ports, so each can be swapped or faked in tests.
- **Incomplete evidence stays inconclusive.** If the system could not check something, it says so rather than reporting a result.

## Leak scan

`npm run leak-scan` fails on anything that looks like an internal identifier: chat workspace IDs, internal hostnames, credentials, and organisation-specific names supplied through a private pattern list. If it flags something in your change, remove the value rather than allowlisting it. Allowlist entries in `.leak-scan-allow` need a reason.

CI also scans what is published alongside the code: commit messages, author and committer emails, and a pull request's branch name, title and description (`node scripts/leak-scan.mjs --metadata`). Commit with your GitHub noreply address or a personal one, and use neutral branch names such as `fix/empty-cart-total`.

## Licence

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
