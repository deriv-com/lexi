# Issue body template

Use these sections. Write "not observed" with a reason when evidence is
missing. Keep sources and results apart from planned work.

```markdown
## Summary
Feature, routes, purpose and scope.

## Source of truth
- Business sources: the headings that cover this feature.
- Build brief and acceptance contract.
- Production code and API documents: paths and commits.
- Live observations: URL, date, environment, browser, viewport, account state,
  region, locale and flags. Say which facts come only from code.

## Design and behaviour
- Screenshots by screen, state, width and locale.
- Layout, navigation, copy, controls and observed breakpoints.
- Production tokens and their design-system mapping; list missing matches.
- Loading, empty, success, failure, blocked, offline and recovery states.
- Keyboard, focus, labels, contrast, touch and screen-reader observations.
- The smallest accessibility or usability fixes, with the reproduced defects.

## Regions and languages
- Region rules and evidence; unobserved cases stay listed.
- Base and flag-controlled locales, selection and fallback.
- Catalogue revision, long-text and right-to-left evidence.

## API calls and events
Call order, trigger, method, endpoint, status, redacted payload and response.
Link the documented contract and mark inferred fields. Analytics events, fields,
success and failure triggers, duplicate risks. Third parties, their purpose,
privacy findings and required behaviour.

## Console and network findings
Message, source, origin, reproduction and proposed fix. Expected network
outcomes listed separately. Slow-network, disconnect and retry observations,
with the test conditions.

## Source conflicts and decisions
For each conflict: business source, live evidence, decision under the build
brief, reason, and the acceptance check it affects.

## Not captured
Missing states, regions, languages and contracts; the evidence needed and the
release checks affected.

## Acceptance criteria
- [ ] Existing design and behaviour preserved, with recorded quality fixes.
- [ ] Critical success, failure and recovery journeys have named checks.
- [ ] API and analytics meaning preserved against unchanged services.
- [ ] Device, network, accessibility and language checks meet the contract.
- [ ] Each result links to its test and evidence.

## Out of scope
Only what this feature does not own, with a link to the owner of the rest.
```
