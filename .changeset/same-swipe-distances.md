---
"@e2e-dev/core": minor
"e2e": minor
"@e2e-dev/web": minor
"@e2e-dev/mobile": minor
"@e2e-dev/desktop": minor
---

**Breaking:** a swipe in a direction takes `distance` and `speed` in place of `momentum`, which is removed. `screen.swipe`, `locator.swipe`, and `scrollUntilVisible` all take them:

- `distance` is how far the content scrolls, as a share of the scroll container along the swipe, above 0 and at most 1. The default is 0.5.
- `speed` is `'slow'`, `'normal'`, or `'fast'`. Each drag takes 1500, 400, or 150 ms, and the default is `'normal'`. The web wheel ignores it.

To keep a test's old stride, set `distance` to what its `momentum` moved:

- On the web, `'slow'` moved 0.75 of the box and `'fast'` 1.5. Use `distance: 0.75`, and `distance: 1` for `'fast'`, since a swipe now moves one container at most.
- On a device, a node swipe moved 0.25 for `'slow'` and 0.8 for `'fast'`. A screen swipe moved about 0.6 with any momentum.
- `'none'` moved 0.5 everywhere, the new default.

The swipe scrolls the scroll container under the screen's center, or the node's nearest scroll container on a locator. Before, it was the whole screen or the node's own box.

On a device:

- Each drag is an agent-device `pan`. It starts a quarter in from the edge the content comes from, so it doesn't start on a footer or tab bar.
- One drag moves at most 0.65 of the container, and a longer `distance` is split into several drags.
- The content coasts on after the finger lifts.

`scrollUntilVisible` steps 0.65 of the container over 800 ms by default, so a step doesn't coast past the 35% of the last view it leaves on screen. Then it brings the node into view:

- On the web, the browser scrolls it into view.
- On a device, a node more than a fifth of its container from the middle is dragged to the middle, clear of a sticky header or footer. `locator.scrollIntoView()` now does the same on a device, and the agent gets `scroll_to` by node id there.

The agent's `scroll` swipes as `screen.swipe` does by default, and `scroll_to({ text })` pages in `scrollUntilVisible` steps.

For engines, `SwipeAction` carries `distance` and `durationMs`, and `SCROLL_STEP` is exported from `@e2e-dev/core/engine`. The desktop engine sends 10 wheel notches for a `distance` of 1.
