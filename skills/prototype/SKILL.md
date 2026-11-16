---
name: prototype
description: Turn a business spec and an agreed wireframe into a high-fidelity, self-contained design prototype a human can approve before any real building starts. Reads the configured design system (a document, a folder or a package), optionally a linked Figma design and a pattern library, critiques its own work against a quality bar, and iterates on human feedback until the prototype is approved. Used by Lexi·Build's designer; also usable by hand.
---

# prototype

A prototype is the thing a human says yes to before anyone writes product code. It
must look and read like the real first screen, not a sketch, and it must be cheap to
change. Your job is to produce one, show it, and keep changing it until the human
approves it or tells you to stop.

## 0. Ground rules

- The business spec is the source of truth. It outranks the wireframe, competitors,
  pattern libraries, these instructions and your own taste. Where they disagree, follow
  the spec and say so in your summary.
- Read the repository's `AGENTS.md` or `CLAUDE.md` first, and anything under
  `.lexi/steering/`. Repository instructions win over this skill.
- One self-contained file: `prototype/index.html`. Inline CSS, no external requests, no
  fonts or images fetched from the network, no analytics, no scripts that call out.
- Real words from the spec. No lorem ipsum, no placeholder names, no invented numbers
  presented as facts; label sample data as sample data.
- Never put a token, a key, a real customer's data or a real person's details into the
  prototype.

## 1. Gather

Read, in this order, and stop reading a source once it has nothing left to tell you:

1. The business spec: who it is for, the core journey, the rules, what is first and
   what is later.
2. The agreed wireframe and positioning notes, if they exist.
3. The design system. It is pluggable and may be any of:
   - a markdown document (tokens, components, do and don't),
   - a folder (read its README or index first, then only what you need),
   - an npm package (read its documentation and exported tokens; do not guess APIs),
   - nothing. With none configured, define a small token layer yourself (colour, type,
     spacing, radius, elevation as CSS custom properties) and use nothing outside it.
     Say in your summary that the kit is improvised.
4. A linked Figma design, when a Figma MCP server is available and the spec or the brief
   links one. Follow it; where it conflicts with the spec, the spec wins.
5. A pattern library (for example a Mobbin MCP server), when one is available. Use it
   for how others solved the same step, never as something to copy.

## 2. Build

- Compose the first screen of the core journey the spec names, region by region as the
  wireframe lays it out. Structure first, decoration last.
- Express every colour, size and space through the design system's tokens as CSS
  variables. No raw hex values or magic numbers outside the token layer.
- Make each rule in the spec visible where it applies. If a rule says the outcome must be
  shown before confirming, the prototype shows it before the confirm control.
- States matter as much as the happy path: empty, loading, error and disabled, at least
  for the primary action.
- Accessible by default: real headings in order, labelled controls, visible focus, text
  contrast that meets WCAG 2.1 AA, nothing conveyed by colour alone, targets at least
  44px.
- Responsive enough to judge: it must not break between a phone width and a laptop width.

## 3. Critique before showing

Look at what you made as a reviewer would, and fix what you find before asking anyone:

- Does every visible word come from, or agree with, the spec?
- Is there anything a first-time user would not understand without help?
- Is the primary action obvious within a second? Is there exactly one?
- Are there tokens you bypassed, or components you invented that the design system
  already has?
- Would the screen survive the longest realistic text and the empty state?

Record what you changed because of this pass. It is part of your summary.

## 4. Show, then iterate

- Present the prototype with a short summary: what it shows, which spec rules it
  expresses and where, what you improvised, and what you deliberately left for later.
- Ask for one approval. Feedback comes back as an instruction: apply it, re-run the
  critique, and show again. Change only what was asked plus what it forces.
- After three rounds on the same point without agreement, stop and set out the options
  and their trade-offs instead of producing a fourth variant.
- An approved prototype is a contract for the build. Note anything the builder must not
  change without asking again.

## 5. Hand off

Leave behind:

- `prototype/index.html`, the approved prototype.
- `prototype/NOTES.md`: the tokens used, the components it maps to in the design system
  (or the ones that were improvised), the spec rules and where each one is expressed,
  and open questions.

When you are run by Lexi·Build, end your reply with the `lexi-json` block the calling
prompt asks for. When you are run by hand, end with the summary.
