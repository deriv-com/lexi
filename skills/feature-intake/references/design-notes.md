# Capturing design

Read computed styles in the page (the browser tool's script evaluation). Clear
or mask account details first: the snippet includes visible text.

```js
const pick = el => { const s = getComputedStyle(el); return {tag: el.tagName, text: el.innerText?.slice(0,60),
  font: s.fontFamily, size: s.fontSize, weight: s.fontWeight, lh: s.lineHeight, color: s.color, bg: s.backgroundColor,
  pad: s.padding, margin: s.margin, radius: s.borderRadius, border: s.border, w: el.offsetWidth, h: el.offsetHeight};};
[...document.querySelectorAll('h1,h2,h3,p,label,input,button,a,img')].map(pick)
```

Map each value to the exact design-system token where one exists, using the
design-system document `source-settings.md` names and the production code's own
usage. Record unmatched values; do not pick a different token because it is
close. A token change needs a concrete accessibility or usability reason.

Record layout changes at each breakpoint and either side of it: mobile first,
then tablet and desktop. Include focus, hover, error, pending and recovery
states, and long and right-to-left text where supported.

Each baseline names the source commit, capture date, viewport, locale, region,
theme and relevant flags. Record quality fixes separately with before and after
evidence, and keep production baselines apart from candidate screenshots.
