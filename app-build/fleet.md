**Work as a fleet.** You are the lead of up to __FLEET_SIZE__ sub-agents (the `Agent` tool; `Task` in older versions of Claude Code). Parallel work is how this run is meant to be fast: do not build alone what sub-agents can build at the same time.

1. **Plan a wave.** Take the next items from the plan that do not depend on each other, at most __FLEET_SIZE__. Give each sub-agent a written work order:
   - **owns**: the only files and folders it may create or edit. Two sub-agents in one wave never own the same file.
   - **reads**: the spec rows, shared modules and sources it needs (by path and ID, so it does not read everything).
   - **must not touch**: shared modules, the app shell, route and navigation registries, `package.json` and lockfiles, global message files, CI and config files, and everything under `__DOCS_DIR__/`. These are yours.
   - **interfaces**: the exact types and functions it codes against. Freeze them before the wave starts; if one is missing, add it yourself first.
   - **done means**: its own unit tests pass (`<test runner> <its paths>`), the type check of its files is clean, and it has committed on its branch. It does not run the full build, the full test suite or a dev server.
   - **test policy**: __FLEET_TEST_POLICY__
   - **if it needs a shared change**: it writes the request in `__FLEET_DIR__/<name>.requests.md` and works around it inside its own files.
2. **Isolate each sub-agent in its own git worktree.** Create it yourself before you launch the sub-agent. Keep it outside the repository so `git add -A` never picks it up. Use:
   `git worktree add -b fleet/<name> __FLEET_DIR__/<name> HEAD`
   A new worktree has no installed dependencies: link the app's instead of installing again, for example `ln -s "$PWD/__APP_DIR__/node_modules" __FLEET_DIR__/<name>/__APP_DIR__/node_modules` (commit your work first, so the worktree starts from it). Tell the sub-agent to work, test and commit only in that directory. Sub-agents never share a checkout: two agents in one checkout corrupt each other's work and the git index.
__FLEET_LIGHT_NOTE__
3. **Launch the whole wave at once.** Send all of the wave's sub-agent calls in one message, so they run in parallel. While they work, do the lead's own work: shared modules, registries, dependency installs, messages.
4. **Integrate before the segment ends.** Give every wave a deadline at least 25 minutes before the segment ends. Work a sub-agent has not committed is lost when the session ends. For each finished sub-agent:
   - `git merge --no-ff fleet/<name>`; resolve any conflict yourself (the ownership rules should leave only registries and message files).
   - Apply its `requests.md`: the shared change, the route, the messages, the dependency.
   - Remove the worktree: `git worktree remove __FLEET_DIR__/<name> && git branch -D fleet/<name>`.

   Then run the type check, lint and the whole unit-test suite once, fix what broke, __FLEET_LOOK__tick PROGRESS.md and commit. Then plan the next wave.
5. **Keep conflicts structural, not lucky.** Each area keeps its own message file, route entries and tests inside its folder, and one index (yours) imports them. If two items need the same new shared module, build it yourself before the wave, never in both sub-agents.
6. **Start each segment clean.** If `git worktree list` or `git branch --list 'fleet/*'` shows sub-agent work left from an earlier segment, merge what is committed and remove the rest before the next wave.
7. **Scale down when it hurts.** On repeated model rate-limit errors (429), or when tests and type checks crawl because the machine is busy, use fewer sub-agents in the next wave. Note it in LAST_SESSION.md.

You own every change a sub-agent makes. Review what you merge; a sub-agent's "done" is a claim until your own checks pass.
