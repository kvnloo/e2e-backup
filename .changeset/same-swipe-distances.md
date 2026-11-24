---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

`screen.swipe`, `locator.swipe`, and `scrollUntilVisible` take `distance` and `speed`, and `momentum` is deprecated:

- `distance`: how far the content scrolls, as a share of the swiped box along the swipe (above 0 and at most 1). The default is 0.5.
- `speed`: `'slow'` (1500 ms a drag), `'normal'` (400 ms), or `'fast'` (150 ms). The default is `'normal'`. It's ignored by the wheel on the web.
- `momentum` still works and prints a warning the first time a run uses it. `'slow'` stands for `distance: 0.25` with `speed: 'slow'`, `'none'` for the defaults, and `'fast'` for `distance: 0.8` with `speed: 'fast'`. A `distance` or `speed` set beside it wins. It will be removed at the end of the deprecation window.

The distances a swipe moves by default changed:

- On the web, `momentum: 'slow'` used to scroll 0.75 of the box and `'fast'` 1.5. They now scroll 0.25 and 0.8.
- On a device, a screen swipe used to move about 0.6 of the screen whatever the `momentum`. It now moves `distance`.
- A screen swipe now scrolls the scroll container under the screen's center instead of the whole screen. A locator swipe still crosses the node's box.

On a device, the start point changed:

- Each drag is an agent-device `pan`. It starts a quarter in from the edge the content comes from, so it doesn't start on a footer or tab bar.
- One drag scrolls 0.65 of the container at most. A longer `distance` is split into several drags.
- The content keeps coasting after the finger lifts.

`scrollUntilVisible`'s steps changed. By default, each step scrolls 0.65 of the container over 800 ms (it was 0.75 on the web and about 0.6 on a device screen). So 35% of the last view stays on screen, and the drag is slow enough that the content doesn't coast past that part. After at least one step, the node is brought into view:

- On the web, it's scrolled into view.
- On a device, a node more than a fifth of its container from the middle is dragged to the middle, clear of a sticky header or footer.

On a device, `locator.scrollIntoView()` is now supported and works like a browser's `scrollIntoViewIfNeeded`: a node fully inside its scroll container doesn't move, and a node cut off at the container's edge is dragged to the middle. The agent can call `scroll_to` with a node id there.

The agent's `scroll` is the same swipe as a `screen.swipe` with the default options. Each page of `scroll_to({ text })` is one `scrollUntilVisible` step.

For engines:

- `SwipeAction` has `distance` and `durationMs` fields in place of `momentum`.
- `scrollIntoView` can carry `center`, which `scrollUntilVisible` sets after a step.
- `SCROLL_STEP` is exported from `@e2e-dev/core/engine`, and `Momentum` stays exported but is deprecated.

On the desktop engine, a `distance` of 1 is sent as 10 wheel notches.
