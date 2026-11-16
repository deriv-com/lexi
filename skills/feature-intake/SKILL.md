---
name: feature-intake
description: Capture one feature of an existing live product so a rebuild can reproduce it. Observe the page, its design, its API calls and console, compare them with the rebuild's own docs, and file one implementation issue with the evidence and the gaps. Used by the programme-feature-intake workflow; also usable by hand. It never writes app code.
---

# feature-intake

You capture **one** feature of a live product for a rebuild of that product,
and turn it into **one** implementation issue in the rebuild repository. A
builder agent later works from that issue and the repository alone, so the
issue must carry every piece of evidence it needs.

This skill produces an issue and its evidence. It never writes app code.

Copy this directory into the rebuild repository as
`.claude/skills/feature-intake/`, then fill in
[references/source-settings.md](references/source-settings.md) for your
product. The `programme-feature-intake` workflow reads the skill from there.

## 0. Ground rules

- Read the repository's `CLAUDE.md` or `AGENTS.md` first, then the documents
  `references/source-settings.md` names (build brief, acceptance contract,
  business sources). Repository instructions win where they disagree with this
  skill, except on the safety rules in section 1.
- Preserve the existing product: design, positioning, business behaviour and
  API contracts. Record accessibility and usability defects with evidence and
  the smallest fix; those fixes are authorised without an approval pause.
- Never fabricate a screenshot, request, response or console message. What you
  did not observe goes under **Not captured**, with the reason.

## Where it runs

- **In GitHub Actions** (the `programme-feature-intake` workflow): follow
  [Running in GitHub Actions](#running-in-github-actions). It overrides the rest
  of this file where they differ.
- **In a Claude Code session** with a browser tool and `gh`.

## 1. Safety on the live site

- Use the production site only for logged-out observation. Do signed-in
  capture on staging with the test account the repository provides.
- Record the environment and account state for every observation. Do not claim
  that staging proves production regions, languages or flags you did not see.
- Never change the test account's password, e-mail, phone or two-step log-in,
  never close it, and never log out other sessions: every later intake needs it.
- Never create other accounts.
- Never write the account's e-mail or password into a file, a screenshot name, a
  log line or the issue. Clear or mask the e-mail before taking screenshots.
- If the site asks for a one-time or two-step code, stop that path and record it
  under **Not captured** with what the screen showed. Describe those steps from
  the business sources and the production code instead.
- Open payment, transfer and trading screens to observe them. Submit a test
  transaction only with a staging account authorised for that test.

## 2. Study the page and its design

Install capture before navigating where you can (section 3), then load the page.

- Capture mobile first at 375 px, then 1440 px. Check 320 px, a tablet width and
  either side of each breakpoint you observe. Capture every supported theme.
  Name each image by screen, state, width and locale.
- Record visible strings, element order, form fields and validation states,
  links and their targets, and every reachable loading, empty and error state.
- Read design tokens from computed styles and map them to the rebuild's design
  system. See [references/design-notes.md](references/design-notes.md).
- Find the production code for the page (when a read-only reference checkout is
  present, it is under `reference/<repo>/`) and cite the files and commit.
  Record the browser, capture date, region and relevant flags.
- Inspect the locale registry, catalogues and language selector. Separate base
  locales, flag-controlled locales and observed availability. Capture long text
  and right-to-left layout where supported. Do not infer coverage from one
  account.
- Inspect keyboard use, focus, labels, touch targets, error recovery and slow
  connections. Record defects with reproducible steps and the smallest fix.

## 3. Capture every API call and console message

Reload with capture on, so nothing from page load is missed. Record the order of
calls and what triggered each one (page load, blur, submit).

- List the network requests, then fetch the bodies. Leave out static assets but
  keep a one-line count of them.
- Read the console at **all levels**: exact text, source file and line, and
  whether it comes from the product or a third party. Separate expected network
  outcomes from defects; never rewrite an API status to make the console clean.
- If bodies or headers are missing, wrap `fetch` and `XMLHttpRequest` in the
  page before the action and dump the log.
- List third-party calls separately. Keep required integrations and the meaning
  of their events; record privacy defects and broken integrations with fixes.
- Capture analytics event names, fields and trigger points for success and
  failure. Check for duplicate events, retry behaviour and typed personal data.

**Redact before saving anything.** Tokens, cookies, `Authorization`, session
ids, CSRF values, flow ids and real e-mails and phone numbers become
`<REDACTED:type>`. Issues are widely visible and cached forever.

## 4. Compare against the rebuild's docs

Look each captured call up in the API documents `references/source-settings.md`
names, and classify it:

- **Match**: documented and identical.
- **Undocumented**: the live call is missing from the docs.
- **Doc-only**: documented but not seen (say which path might trigger it).
- **Mismatch**: method, path, payload fields, status, response shape or call
  order differ. Quote both sides.

Compare each rule, message and failure case with the business sources. When
sources conflict, follow the build brief's precedence, keep the production
behaviour, and record the conflict with its evidence. Unknown API or regional
behaviour stays unknown and is listed as needing verification.

## 5. Write the issue

Fill [references/issue-template.md](references/issue-template.md). Title:
`feat(<feature>): rebuild <feature> (<web|mobile>)`.

In a Claude Code session, search first (`gh issue list --search`) and comment on
an open issue instead of filing a duplicate. Otherwise file it with
`gh issue create --label type:feature --label platform:<web|mobile> --label needs-spec --body-file <file>`.
`gh` cannot upload images: commit them only if the person agrees, otherwise list
the local paths. Never claim an image is attached when it is not.

## 6. Hand-off labels

The default is **no approval pause**.

- `ready-for-agent` for scoped work. It permits building; it is not release
  approval, and it does not make unknown contracts known.
- `needs-approval` only when it was explicitly requested, or when a person must
  decide something before the build (an unresolved mismatch, for example). Say
  what needs approval and leave `ready-for-agent` off until it is given.
- A proposed change outside the rebuild's authority is recorded separately; keep
  the production behaviour and continue the authorised work.

## Running in GitHub Actions

The workflow prompt names the feature, the output folder and whether a test
account is in the environment. There:

- The browser is the `playwright` MCP server, headless. Use its tools to
  navigate, type, take screenshots, evaluate scripts in the page, and read the
  network and console.
- A test account, when provided, is `TEST_ACCOUNT_EMAIL` and
  `TEST_ACCOUNT_PASSWORD` in the environment. Read them from the environment
  when you fill the log-in form. Use the account only on staging.
- You have no GitHub token. Write `title.txt`, `issue.md`, the screenshots in
  `assets/`, an optional `labels.txt`, and `needs-approval.md` when section 6
  calls for approval. The workflow checks the files for secrets, files the issue
  with its labels, and makes the screenshots render. Refer to screenshots as
  `assets/<file>.png`.
- Nobody answers questions during the run. Make the implementation and quality
  choices you are authorised to make and record why. Leave unknown evidence
  unknown rather than inventing a business rule or an unobserved result.

## Report

End by reporting the issue URL (or the files written), the labels, whether
approval is pending, the open mismatches, and what was not captured.
