---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
---

`app.screenshot(label, { fullPage, clip })` captures the whole scrollable page or one rectangle of it, and `expect(screen).toHaveScreenshot({ fullPage, clip })` compares them, as Playwright's `page.screenshot` and `toHaveScreenshot` do. A `clip` of the viewport needs no new capability: e2e cuts it from the engine's screenshot on any engine that observes and writes PNG screenshots. `fullPage` needs an engine that declares the new `fullPageScreenshots` capability: the engine then receives `{ fullPage, clip }` in `artifacts.screenshot` and `fullPage` beside `pixels` in `observe`, and reports where the viewport sits in full-page pixels as `ObservationPixels.scroll`. The web engine declares it and masks secure fields across the whole page. On any other engine, `fullPage` fails with `UNSUPPORTED_CAPABILITY` before anything is captured. A locator's `toHaveScreenshot` takes neither option.
