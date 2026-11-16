## Rubric — spec

Block the phase if any of these fails:
1. Every document the phase asks for exists under `docs/build/spec/`, and `README.md` indexes them.
2. **Coverage.** `coverage.md` maps every in-scope requirement in the sources to spec rows. Sample at least 15 requirements from the sources yourself (rules, unhappy paths, exact messages, limits and timings) and check each is in `rules.md` with its source reference; any in-scope requirement missing blocks.
3. **Unhappy paths.** For each screen in scope, the error, empty, loading and edge states the sources describe are specified, with exact copy.
4. **Journeys.** Every in-scope journey from the sources is in `journeys.md` as concrete steps with a test that would prove it.
5. **API.** Every screen action names a real operation from the contracts (check a sample against the contract files) or is marked as a gap with a fallback. An invented endpoint blocks.
6. **Integrations and design system.** Each in-scope integration and the design-system usage are specified enough to build without reopening the sources.
7. Nothing contradicts `INTENT.md` or `DECISIONS.md` without a recorded reason.
