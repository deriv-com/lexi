## Rubric — intent

Block the phase if any of these fails:
1. `docs/build/INTENT.md` exists and has every section the phase asks for: objective, users, scope of this run, sources and precedence, conflicts found, assumptions and risks, definition of done.
2. The objective and the scope match the sources and BUILD.md. Nothing in scope is missing; nothing out of scope has crept in.
3. Every source BUILD.md names is listed with what it decides, and the precedence rule is stated.
4. Real conflicts between the sources are found and each is resolved with a reason and recorded in `DECISIONS.md`. Spot-check: look for two or three contradictions yourself; a missed one blocks.
5. The definition of done is checkable (tests, journeys, checks), not aspirational.
