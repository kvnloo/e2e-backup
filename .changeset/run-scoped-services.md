---
"@e2e-dev/core": patch
"e2e": patch
---

Services start the dependencies of the app under test, such as an email API or an OAuth provider, before the app commands, and stop them at the end of the run. Declare one with `defineService({ async *start() { ...; yield value; ... } })` and add it to the config's `services`. Every worker shares one instance. `app.command.env` can now be a function that reads the services' values, and tests read them through the `services` fixture, where each function is an async call to the runner process. `defineConfig` is back: it types `services` in `env` from the config's `services`. A project fixture named `services` now extends the built-in one, so it becomes a worker fixture: rename it if it's a test fixture.
