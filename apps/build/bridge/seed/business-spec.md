# Business Spec — Acme Markets (sample)

> The sample spec Lexi·Build uses when you give it none. Point `LEXI_BUSINESS_SPEC`
> at your own spec to build your product instead. Lexi reads the `**For:**` and
> `**Core journey:**` lines, the numbered rules, and the `lexi-decisions` block below.

**For:** people placing their first small investment, who find professional platforms intimidating.
**Core journey:** pick a market → set an amount → place the order, in under a minute.

## Why this exists

Most market apps are built for experts and merely tolerated by beginners. This one is
built for the first order: someone who has never invested should go from landing to a
completed practice order without help, without fear of breaking something, and without
committing real money before they understand what they are doing.

## Rules

- R1 Practice before real money. A new user's first order is always a practice order;
  real money is offered only after a completed practice order.
- R2 The outcome is always visible before confirming. Before any order is confirmed,
  the user can see what they stand to gain and what they stand to lose.
- R3 Risk is never hidden. The maximum loss is stated as plainly as the potential gain,
  wherever an order is offered.
- R4 One home currency for the first release: USD.
- R5 Plain words. The same word for the same thing on every screen; no jargon without a
  one-line explanation next to it.

## First release vs later

- First: one screen — markets, live price, order panel (amount, outcome, confirm),
  practice-first (R1), USD.
- Later: portfolio depth, charting, multiple currencies.
- Never: professional charting suites aimed at experts.

## Success

A first-time user completes a practice order in under a minute, and can say — before
confirming — what they could gain and what they could lose.

<!-- lexi-decisions: [{"title":"Who is the first release for?","why":"The spec leans first-timers, but the audience decides how much we strip down.","options":[{"label":"First-time investors","note":"Simplest possible first order · R1–R3 as written","rec":true},{"label":"Experienced investors","note":"Charting and depth move to the home screen"},{"label":"Both at once","note":"Two experiences to design, review and test"}]}] -->
