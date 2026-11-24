---
"@e2e-dev/core": minor
"e2e": minor
"@e2e-dev/web": minor
"@e2e-dev/mobile": minor
"@e2e-dev/desktop": minor
---

**Breaking:** `momentum` is replaced by `distance` and `speed` in `screen.swipe`, `locator.swipe`, and `scrollUntilVisible`:

- `distance`: how far the content scrolls, as a share of the scroll container along the swipe (above 0 and at most 1). The default is 0.5.
- `speed`: `'slow'` (1500 ms a drag), `'normal'` (400 ms), or `'fast'` (150 ms). The default is `'normal'`. It's ignored by the wheel on the web.

To keep a test's old stride, set `distance` to how far the content scrolled with its old `momentum`:

- On the web, the content scrolled 0.75 of the box with `'slow'` and 1.5 with `'fast'`. Use `distance: 0.75` for `'slow'` and `distance: 1` for `'fast'`, since a swipe now scrolls one container at most.
- On a device, a node swipe moved 0.25 with `'slow'` and 0.8 with `'fast'`. A screen swipe moved about 0.6 with any `momentum`.
- In every other case (`'none'`), the content moved 0.5, the same as the new default.

A screen swipe now scrolls the scroll container under the screen's center instead of the whole screen. A locator swipe still crosses the node's box.

On a device:

- Each drag is an agent-device `pan`. It starts a quarter in from the edge the content comes from, so it doesn't start on a footer or tab bar.
- One drag scrolls 0.65 of the container at most. A longer `distance` is split into several drags.
- The content keeps coasting after the finger lifts.

By default, each `scrollUntilVisible` step scrolls 0.65 of the container over 800 ms. So 35% of the last view stays on screen. The drag is slow enough that the content doesn't coast past that part.

After at least one step, the node is brought into view:

- On the web, it's scrolled into view.
- On a device, a node more than a fifth of its container from the middle is dragged to the middle, clear of a sticky header or footer.

On a device, `locator.scrollIntoView()` is now supported and drags a node to the middle the same way. The agent can call `scroll_to` with a node id there.

The agent's `scroll` is the same swipe as a `screen.swipe` with the default options. Each page of `scroll_to({ text })` is one `scrollUntilVisible` step.

For engines:

- `SwipeAction` has `distance` and `durationMs` fields.
- `SCROLL_STEP` is exported from `@e2e-dev/core/engine`.

On the desktop engine, a `distance` of 1 is sent as 10 wheel notches.
