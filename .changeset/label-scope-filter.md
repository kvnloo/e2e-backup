---
'@e2e-dev/web': patch
---

An exact `getByLabel` locator with a `filter` after `first()`, `last()`, or `nth()` keeps that filter when it scopes another query, serves as `filter({ has })`, or is a `within`. Before, the scope dropped the filter: `screen.getByLabel('Billing').first().filter({ hasText: '19.99' }).getByRole('button')` searched the first Billing group even when it did not hold 19.99.
