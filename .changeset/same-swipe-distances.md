---
"@e2e-dev/core": minor
"@e2e-dev/web": minor
"@e2e-dev/mobile": minor
---

**Breaking:** a swipe with a direction moves the same share of the box on the web and on a device. The box is the node, or the viewport on `screen`, and the share is measured along the swipe:

- `slow`: 0.25 (0.75 on the web before)
- `none`: 0.5
- `fast`: 0.8 (1.5 on the web before)

On a device, `screen.swipe({ direction })` used to move about 0.6 of the viewport for every momentum. It follows the momentum now.

`scrollUntilVisible` steps with `slow`, so it takes shorter steps on the web and on a device screen. If a long scroll now runs out of time, pass `momentum: 'fast'` or a longer `timeout`.

The agent's `scroll`, and `scroll_to({ text })` while it pages, swipe with `fast`, 0.8 of the list or screen per swipe. That's close to the 0.75 they moved on the web, and more than on a device (0.25 of a list, about 0.6 of the screen).

Engines can read the shares from `SWIPE_SHARE` in `@e2e-dev/core/engine`.
