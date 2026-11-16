# Vendored skills — seeded into every workspace's `.lexi/skills/` (and `.kiro/skills/`)

| Skill | Upstream | Commit | Licence | Used by |
|---|---|---|---|---|
| `taste/` | https://github.com/Leonxlnx/taste-skill (`skills/taste-skill`) | `9da1763c950baed17a69158a5f4c76f8f85bf49b` (tasteskill v2) | MIT, © 2026 Leonxlnx | Pixel, Forge — marketing/landing surfaces, art direction, anti-slop |
| `hallmark/` | https://github.com/nutlope/hallmark (`skills/hallmark`) | `f5f4a2ceb0ff302f2e69fb33679501611eadee32` (1.1.0) | MIT, © 2026 Hallmark contributors | Pixel, Forge, Check — all UI: structural variety, anti-AI-slop rules |

Vendored (not fetched at runtime) so every run is reproducible and works offline. Each
folder carries its upstream `LICENSE`; attribution is also in the repository `NOTICE`.

Local changes against upstream, kept minimal:

- `taste/`: the upstream `evals/` folder is not vendored (it is test material for the skill
  itself, not used at runtime).
- `hallmark/SKILL.md`: one word in the front-matter description (the adjective before "pages" now reads "new").

To update: re-copy the upstream folder at a new commit, re-apply the changes above, and
update this table and `NOTICE`.
