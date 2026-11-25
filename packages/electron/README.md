# @e2e-dev/electron

The Electron engine for [`e2e`](https://www.npmjs.com/package/e2e): an
Electron app's windows, read through Chromium's accessibility tree over the
DevTools protocol and driven with trusted input, through the same
`@e2e-dev/core/engine` contract the browser, mobile, and desktop engines
implement. A test written against `screen`, `expect`, `app`, and `agent` runs
on an Electron target unchanged.

It is also the reference for an engine built outside this repository: it
imports only `@e2e-dev/core/engine` and Playwright's public Electron launcher,
never another engine. [Engines](https://e2e.com/docs/engines) lists what
building it changed in the contract.

## Install

```bash
npm install --save-dev e2e @e2e-dev/electron electron
```

The engine starts the `electron` package installed in the project, and
downloads its binary one time per run when it is missing. Run
`npx e2e doctor` to check.

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { electron } from '@e2e-dev/electron';

export default {
  targets: [{ name: 'electron', engine: electron(), app: { appPath: '.' } }],
} satisfies E2EConfig;
```

`app.appPath` is the app's directory or main script, and `app.launchArguments`
go after it on every launch. For a packaged app, pass
`electron({ executablePath })` and leave out `appPath`.

```ts title="tests/sign-in.e2e.ts"
import { test } from '@e2e-dev/electron';
import { credentials, expect } from 'e2e';

test('signs in', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('textbox', 'Username').fill('ada');
  await screen.getByRole('textbox', 'Password').fill(credentials.user('ada').password);
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByTestId('status')).toContainText('Signed in');
});
```

## How it works

- `app.open()` launches the app on an empty user-data directory of the test's
  own and waits for its first window. `app.restart()` launches it again on the
  same data, `app.clearState()` on empty data. Every test ends with the app
  quit.
- An observation joins Chromium's accessibility tree with one DOM snapshot of
  the same window. Nothing runs in the app's page to read it.
- Actions wait until the node is enabled, on screen, and the topmost element
  at its point, then send trusted mouse and keyboard input. Text goes only to
  the node that holds focus.
- The app's windows are the tabs the agent switches between. The `electron`
  fixture runs code in the main process (`evaluate`), lists the windows, picks
  the one `screen` reads (`useWindow`), and finds elements by CSS selector
  (`locator`).
- A password field reports no value, and screenshots paint password fields
  and nested documents over. One inside a closed shadow root, which no mask
  reaches, withholds the screenshot.
- Not supported yet: video, session save and restore, `toBeInViewport`,
  computed-style checks, and content inside an `iframe` or `webview`.

## License

Apache-2.0
