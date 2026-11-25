---
'e2e': patch
---

`e2e cache show <entry>` prints one replay cache entry action by action, with the screen each action ran on, the end state a replay checks, and any detour, so a recording reads without opening its JSON. `<entry>` is the entry digest, as many leading characters as tell it apart, or the path of its file. `e2e cache check` lists every entry whose flow leaves a screen and comes back to it with nothing changed, and exits 1 when it finds one, so a pipeline can stop a recording with a wrong turn before it is committed. `e2e cache ls` now opens each row with the first 12 characters of the entry digest and marks an entry that takes a detour.
