---
'@e2e-dev/mobile': patch
---

On iOS, `getByText` matches a control by one part of its merged label when no label matches whole, so `getByText('Trail Mix')` finds a card labelled `Trail Mix, 250 g`. [Merged labels on iOS](https://e2e.com/docs/reference/mobile#merged-labels-on-ios)
