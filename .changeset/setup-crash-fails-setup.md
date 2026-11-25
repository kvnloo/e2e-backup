---
"e2e": patch
---

A setup whose worker dies after its attempt passed, in `afterAll` or while saving its sessions, is now reported failed with `WORKER_CRASH`. Before, it showed as passed while the tests that use its sessions were skipped as "setup failed".
