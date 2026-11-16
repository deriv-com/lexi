# Lexi·Build — the builder crew

Type what you want built, and a crew of agents takes it from an idea to a working app
on your machine. Lexi manages the job: a researcher looks at the competition, a designer
wireframes and prototypes, a writer does the copy, a builder writes the code, and a
reviewer and a tester check it. You answer the decisions only a person can make, approve
the prototype before anything is built, and approve the result before it ships.

Under the hood it is a local web UI (the **Table**) and a small Node bridge that runs the
crew through one product build: intent → spec → plan → wireframe → prototype → build ⇄
review → ship.

Everything runs on your machine. The agents are the coding CLIs you already have
(Claude Code, Kiro, Cursor Agent or Codex), started as child processes in a workspace
folder the bridge creates for each build.

## Run it

```bash
npm install                      # from the repository root
npm start -w @lexi/build         # starts the bridge on http://127.0.0.1:7341
```

Open <http://127.0.0.1:7341/build.html> for the Table, or <http://127.0.0.1:7341/> for
the landing page. `GET /health` reports the configuration the bridge loaded. Stop it with
Ctrl-C.

You need Node 20.12 or later and at least one agent CLI on your `PATH` and logged in.
The default runner is `claude` (Claude Code); pick another in the Table or with
`LEXI_RUNNER`.

To configure it, copy [`bridge/.env.example`](bridge/.env.example) to `bridge/.env`.
Every value is optional:

| Setting | What it does |
|---|---|
| `LEXI_BUSINESS_SPEC` | Your business spec. Without it the crew builds the sample in `bridge/seed/business-spec.md`. |
| `LEXI_DESIGN_SYSTEM` | Your design system: a markdown file, a folder of docs, or an npm package name (`LEXI_DESIGN_SYSTEM_VERSION` pins the package). Without one, agents define a small token layer and say so. |
| `LEXI_SOURCES_DIR` | Canonical docs (API specs, standards) copied into each workspace's `docs/`. |
| `LEXI_REFERENCE_APP_DIR` | An existing app agents may read and borrow from, linked read-only at `references/app`. |
| `LEXI_MOBBIN_MCP_URL` | A pattern-library MCP server for competitor research. Optional; without it Scout researches from its own knowledge and says so. |
| `LEXI_FIGMA_MCP_URL` | A Figma MCP server Pixel can read designs from. The agent CLI handles the Figma login. |
| `LEXI_WORKSPACE_ROOT` | Where build folders go (default `~/LexiBuilds`). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | Read by the agent CLIs themselves, if you route them through a key or a gateway instead of their own login. |

MCP URLs must be HTTPS, or plain HTTP on a loopback address; anything else is ignored.

## The crew

| Persona | Does |
|---|---|
| Lexi | Manages the job. Each turn it sees the state and returns one action: dispatch work, ask a decision, ask an approval, ship, or finish. |
| Lexi (spec playbook) | Writes the business spec from your intent, when Lexi decides the job needs one. |
| Scout | Research: competitors, the reference app, patterns. |
| Pixel | Wireframe and the design prototype (follows [`skills/prototype`](../../skills/prototype/SKILL.md)). |
| Words | The copy: headlines, labels, empty states, in the spec's own terms. |
| Data | Data shapes, realistic sample data, and how the real API replaces it. |
| Forge | Builds the real app, region by region or all at once, and fixes findings. |
| Check | Reviews what Forge built against the spec, the prototype and the quality bar. |
| Probe | Uses the build: the core journey and the edge cases, and reports what breaks. |

Personas and their prompts are plain markdown in `bridge/personas/` and `bridge/prompts/`.

## The guardrails are code, not prompt

Lexi plans the order freely, but the bridge enforces:

- **No building before the prototype is approved.** A Forge dispatch before a granted
  prototype approval is refused and Lexi is told why.
- **No shipping before the ship approval.** Declining it leaves the build where it is.
- A step budget (`LEXI_MAX_STEPS`), a per-run timeout (`LEXI_PHASE_TIMEOUT_MS`), and a stop
  after three manager turns that are not a valid action.

## Each build's workspace

`<LEXI_WORKSPACE_ROOT>/<slug>/` holds the business spec, the docs, the design-system notes
and house rules in `.lexi/steering/`, the skills in `.lexi/skills/`, the MCP settings
(`.mcp.json`, `.lexi/mcp.json`), and `AGENTS.md`/`CLAUDE.md` indexing all of it. A copy goes
to `.kiro/` because Kiro reads its steering from there. Shipped output is served back at
`/preview/<slug>/`.

## Safety

- The bridge listens on 127.0.0.1 only. The WebSocket accepts loopback origins, plus any
  listed in `LEXI_ALLOWED_ORIGINS`.
- Preview and UI paths are resolved and checked to stay inside their folder; encoded
  traversal is refused.
- The bridge passes its environment to the agents it starts. Put in `bridge/.env` only
  what the agents should be able to use. `.env` and the run history are git-ignored.
- Agents run with your user's permissions in the workspace folder. Treat a build like any
  other code an agent wrote: review it before you run it anywhere that matters.

## The WebSocket protocol

The Table and the bridge exchange JSON messages on `ws://127.0.0.1:7341`.

From the UI: `intent` (start a build), `decision-answer`, `approval-answer`
(`verdict`: `approve` or `changes`, with an `instruction`), `steer`, `ask`, `cancel`,
`set-runner`, `status-query`.

From the bridge: `project`, `phase`, `summon`, `move`, `say`, `edit`, `artifact`,
`wireframe`, `pin`, `decision`, `approval`, `ship`, `sys`, `done`, `error`,
`status-report`.

## Develop

```bash
npm run check -w @lexi/build     # syntax-check the bridge and the UI
npx vitest run apps/build        # bridge specs, with a runner double instead of a real agent
npx eslint apps/build
```

The vendored skills in `bridge/skills/` are third-party (MIT). See
[`bridge/skills/README.md`](bridge/skills/README.md) and the repository `NOTICE`.
