## Rubric — plan

Block the phase if any of these fails:
1. `docs/build/PLAN.md` states the stack and architecture, consistent with BUILD.md and the technical standards it names.
2. **Shared foundations come first** and are named with their files. No module that several screens need is left for each screen to build itself.
3. Milestones follow the scope and order BUILD.md sets, and each lists screens, spec rule IDs, API operations, integrations and a checkable definition of done with the tests the run's test policy names.
4. Every in-scope spec rule ID is assigned to exactly one milestone; spot-check at least 10.
5. `docs/build/PROGRESS.md` exists, its first line is `Status: building`, and it mirrors the plan's milestones as a checklist.
6. The work is ordered so the app stays runnable after each step.
