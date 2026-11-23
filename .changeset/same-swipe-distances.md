---
"@e2e-dev/core": minor
"@e2e-dev/web": minor
"@e2e-dev/mobile": minor
---

**Breaking:** a swipe with a direction now travels the same share of the box on the web and on a device. The box is the node (or the viewport, on `screen`). The share is measured along the swipe:

- `slow`: 0.25 (was 0.75 on the web)
- `none`: 0.5
- `fast`: 0.8 (was 1.5 on the web)

Before, a `screen.swipe({ direction })` on a device traveled about 0.6 of the viewport with any momentum. Now the distance depends on the momentum.

Steps of `scrollUntilVisible` use `slow` by default, so they're now shorter on the web and on a device screen. If a long scroll now runs out of time, pass `momentum: 'fast'` or a longer `timeout`.

The agent's swipes now use `fast` (0.8 of the list or screen). This applies to `scroll`, and to `scroll_to({ text })` when it pages through a list. Before, those swipes traveled:

- On the web: 0.75
- On a device: 0.25 of a list, and about 0.6 of the screen

The shares are exported for engines as `SWIPE_SHARE` from `@e2e-dev/core/engine`.
