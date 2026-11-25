import { readFileSync } from 'node:fs';
import { Transformer } from '@napi-rs/image';
import { test } from '@e2e-dev/electron';
import { credentials, expect } from 'e2e';

test.describe('sign-in window', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('signs in through the preload bridge with every control set', async ({ screen, electron }) => {
    const ada = credentials.user('ada');
    await expect(screen.getByRole('status').first()).toHaveText('Not signed in');
    await screen.getByRole('textbox', 'Username').fill(ada.username);
    await screen.getByRole('textbox', 'Password').fill(ada.password);
    await screen.getByRole('checkbox', 'Remember me').check();
    await expect(screen.getByRole('checkbox', 'Remember me')).toBeChecked();
    await screen.getByRole('combobox', 'Plan').selectOption('Team');
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Team');
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Signed in as ada on Team, remembered (main process saw 7 characters)');
    const signIns = await electron.evaluate(() => (globalThis as unknown as { testbedState: { signIns: unknown[] } }).testbedState.signIns);
    expect(signIns).toEqual([{ username: 'ada', plan: 'Team', remember: true }]);
  });

  test('reads controls by test id and placeholder, and refuses an empty password', async ({ screen }) => {
    await screen.getByPlaceholder('ada').fill('grace');
    await expect(screen.getByTestId('username')).toHaveValue('grace');
    await expect(screen.getByTestId('username')).not.toBeEmpty();
    await screen.getByTestId('username').clear();
    await expect(screen.getByTestId('username')).toHaveValue('');
    await expect(screen.getByTestId('username')).toBeEmpty();
    await expect(screen.getByTestId('wide-result')).toBeEmpty();
    await screen.getByTestId('sign-in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Password is required');
  });

  test('reads what a control submits: a select its option value, a checkbox on', async ({ screen }) => {
    const region = screen.getByTestId('region');
    await expect(region).toHaveValue('eu-1');
    await region.selectOption('America');
    await expect(region).toHaveValue('us-1');
    expect(await screen.getByRole('checkbox', 'Remember me').inputValue()).toBe('on');
    await expect(screen.getByTestId('due')).toHaveValue('2026-01-02');
    await screen.getByTestId('due').fill('2026-03-04');
    await expect(screen.getByTestId('due')).toHaveValue('2026-03-04');
    const malformed = await screen.getByTestId('due').fill('next week', { timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    expect(String(malformed)).toContain('does not take');
    await expect(screen.getByTestId('notes')).toHaveValue('Bring the badge');
    // A select holds its options' text, so it is not empty.
    await expect(region).not.toBeEmpty();
  });

  test('refuses an option in a disabled group', async ({ screen }) => {
    const refused = await screen.getByRole('combobox', 'Plan').selectOption('Legacy', { timeout: 2000 }).then(() => undefined, (error: unknown) => error);
    expect(String(refused)).toContain('is disabled');
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Pro');
  });

  test('submits with the Enter key and types into the focused field', async ({ screen }) => {
    await screen.getByTestId('username').tap();
    await screen.getByTestId('username').pressSequentially('lin');
    await screen.getByTestId('password').fill('correct horse');
    await screen.getByTestId('password').press('Enter');
    await expect(screen.getByTestId('status')).toHaveText('Signed in as lin on Pro (main process saw 13 characters)');
  });

  test('refuses to type into a field that hands focus on to another', async ({ screen }) => {
    const refused = await screen.getByTestId('handoff').fill('typed', { timeout: 2000 }).then(() => undefined, (error: unknown) => error);
    expect(String(refused)).toContain('did not keep keyboard focus');
    const typed = await screen.getByTestId('handoff').pressSequentially('typed', { timeout: 2000 }).then(() => undefined, (error: unknown) => error);
    expect(String(typed)).toContain('did not keep keyboard focus');
    await expect(screen.getByTestId('username')).toHaveValue('');
  });

  test('fills and clears a field that swallows key presses, since fill sends none', async ({ screen }) => {
    const invite = screen.getByTestId('invite');
    await invite.fill('ABC-123');
    await expect(invite).toHaveValue('ABC-123');
    await invite.fill('');
    await expect(invite).toHaveValue('');
    await invite.fill('XYZ');
    await invite.clear();
    await expect(invite).toHaveValue('');
  });

  test('sends no text once a fill has run out of time', async ({ screen }) => {
    const refused = await screen.getByTestId('slow').fill('late', { timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    expect(String(refused)).not.toBe('undefined');
    // The focus handler returns after two seconds; a fill still running then would type now.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await expect(screen.getByTestId('slow')).toHaveValue('');
  });

  test('taps a button wider than the window', async ({ screen }) => {
    await screen.getByRole('button', 'Wide action').tap();
    await expect(screen.getByTestId('wide-result')).toHaveText('Wide action ran');
  });

  test('drags to a drop zone below the edge of the window', async ({ screen }) => {
    await screen.getByRole('button', 'Drag me').dragTo(screen.getByRole('button', 'Drop here'));
    await expect(screen.getByTestId('drag-result')).toHaveText('Dropped drag-source on the zone');
  });

  test('stops typing once pressSequentially has run out of time', async ({ screen }) => {
    const laggy = screen.getByTestId('laggy');
    const refused = await laggy.pressSequentially('abcdefgh', { timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    expect(String(refused)).not.toBe('undefined');
    // Eight keys take 2.4 seconds; typing that went on past the timeout would finish by now.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await laggy.inputValue()).length).toBeLessThan(8);
  });

  test('refuses a key the keyboard has no key for, before focus moves', async ({ screen }) => {
    const refused = await screen.getByTestId('username').press('é').then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await screen.getByTestId('username').press('$');
    await expect(screen.getByTestId('username')).toHaveValue('$');
  });

  test('waits for enabled the way the tree reports it', async ({ screen }) => {
    const locked = screen.getByRole('button', 'Locked action');
    await expect(locked).toBeDisabled();
    const refused = await locked.tap({ timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    expect(String(refused)).toContain('it is disabled');
    // A disabled fieldset disables its form controls, not a link inside it.
    await screen.getByRole('link', 'Open archive').tap();
    await expect(screen.getByTestId('link-result')).toHaveText('Archive opened');
  });

  test('passes the launch arguments to the app', async ({ screen }) => {
    await expect(screen.getByRole('heading', { name: 'Hello from e2e', level: 1 })).toBeVisible();
  });

  test('counts taps and reads text a locator scopes', async ({ screen, electron }) => {
    const counter = screen.getByRole('region', 'Counter');
    await counter.getByRole('button', 'Add one').tap();
    await counter.getByRole('button', 'Add one').dblclick();
    await expect(screen.getByTestId('count')).toHaveText('3');
    await expect(electron.locator('#increment')).toHaveText('Add one');
    // Each run of text is found on its own, as on the web, and the line reads as all of them.
    await expect(screen.getByText('$10')).toBeVisible();
    await expect(screen.getByText('Price')).toHaveCount(1);
    await expect(screen.getByTestId('price')).toHaveText('Price $10');
    // A label wrapping a field is a container Chromium's tree leaves out; a selector still reaches it.
    await expect(electron.locator('#sign-in > label').first()).toHaveText('Username');
    await expect(electron.locator('#sign-in > label')).toHaveCount(4);
    // A web component's content is in an open shadow root.
    await expect(electron.locator('.badge')).toHaveText('Beta');
    // A hidden element is still there for a selector to count.
    await expect(electron.locator('#spinner')).toHaveCount(1);
    await expect(electron.locator('#spinner')).toBeHidden();
    // Reads at the same time keep their own handles.
    expect(await Promise.all([electron.locator('#increment').count(), electron.locator('#items li').count()])).toEqual([1, 40]);
  });

  test('scrolls a list to an item below its edge', async ({ screen }) => {
    const last = screen.getByText('Item 40', { exact: true });
    await last.scrollIntoView();
    await expect(last).toBeVisible();
    await screen.getByRole('list', 'Items').swipe({ direction: 'up' });
    await expect(screen.getByRole('listitem').filter({ hasText: 'Item 1' }).first()).toBeVisible();
  });

  test('starts every test from a fresh launch with empty app data', async ({ screen, electron }) => {
    await expect(screen.getByTestId('username')).toHaveValue('');
    await expect(screen.getByRole('checkbox', 'Remember me')).not.toBeChecked();
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Pro');
    const state = await electron.evaluate(() => (globalThis as unknown as { testbedState: { signIns: unknown[] } }).testbedState);
    expect(state.signIns).toEqual([]);
  });

  test('keeps app data across app.restart() and empties it with app.clearState()', async ({ app, screen }) => {
    await screen.getByTestId('username').fill('ada');
    await screen.getByTestId('password').fill(credentials.user('ada').password);
    await screen.getByRole('checkbox', 'Remember me').check();
    await screen.getByTestId('sign-in').tap();
    await expect(screen.getByTestId('status')).toHaveText(/^Signed in as ada/);
    await app.restart();
    await expect(screen.getByTestId('status')).toHaveText('Welcome back, ada');
    await expect(screen.getByTestId('username')).toHaveValue('ada');
    await app.clearState();
    await expect(screen.getByTestId('status')).toHaveText('Not signed in');
    await expect(screen.getByTestId('username')).toHaveValue('');
  });
});

test.describe('an app that quits on its own', () => {
  test('relaunches with app.restart() and ends the test cleanly', async ({ app, screen, electron }) => {
    await app.open();
    await screen.getByTestId('username').fill('ada');
    await electron.evaluate(({ app: main }) => setTimeout(() => main.quit(), 50));
    await expect.poll(async () => (await electron.windows()).length).toBe(0);
    await app.restart();
    await expect(screen.getByTestId('status')).toHaveText('Not signed in');
    await electron.evaluate(({ app: main }) => setTimeout(() => main.quit(), 50));
    await expect.poll(async () => (await electron.windows()).length).toBe(0);
  });
});

test.describe('screenshots', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('paints the password field over and keeps the field beside it', async ({ app, screen }) => {
    const password = screen.getByTestId('password');
    await screen.getByTestId('username').fill('ada');
    await password.fill(credentials.user('ada').password);
    const field = await password.boundingBox();
    const beside = await screen.getByTestId('username').boundingBox();
    expect(field).not.toBeNull();
    expect(beside).not.toBeNull();
    const image = decode(new Uint8Array(readFileSync(await app.screenshot('filled'))));
    // The window is 640 CSS pixels wide: the capture's width over that is its scale.
    const scale = image.width / 640;
    expect(blackShare(image, field!, scale)).toBe(1);
    expect(blackShare(image, beside!, scale)).toBeLessThan(0.5);
  });

  test('withholds a screenshot of a window whose password field no mask reaches', async ({ app, screen, electron }) => {
    await screen.getByRole('button', 'Open settings').tap();
    await electron.useWindow({ title: 'Settings' });
    await expect(screen.getByRole('textbox', 'Vault key')).toHaveCount(1);
    const refused = await app.screenshot('vault').then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'POLICY_DENIED' });
  });
});

test.describe('windows', () => {
  test('drives a second window the app opens', async ({ app, screen, electron }) => {
    await app.open();
    await screen.getByRole('button', 'Open settings').tap();
    const settings = await electron.useWindow({ title: 'Settings' });
    expect(settings.index).toBe(1);
    await screen.getByRole('switch', 'Dark mode').check();
    await expect(screen.getByTestId('theme')).toHaveText('Theme: dark');
    const windows = await electron.windows();
    expect(windows.map((window) => [window.title, window.shown])).toEqual([
      ['Sign In', false],
      ['Settings', true],
    ]);
    await electron.useWindow(0);
    await expect(screen.getByTestId('status')).toHaveText('Not signed in');
    const missing = await electron.useWindow({ title: 'Preferences' }).then(() => undefined, (error: unknown) => error);
    expect(String(missing)).toContain('no window matches title Preferences; open: "Sign In", "Settings"');
    expect(await electron.evaluate(() => (globalThis as unknown as { testbedState: { settingsOpened: number } }).testbedState.settingsOpened)).toBe(1);
  });
});

/** A decoded capture: its width, its pixels rows top to bottom, and how many bytes each takes (3 for RGB, 4 for RGBA). */
interface Image {
  readonly width: number;
  readonly pixels: Uint8Array;
  readonly channels: number;
}

function decode(png: Uint8Array): Image {
  const transformer = new Transformer(png);
  const { width, height } = transformer.metadataSync();
  const pixels = transformer.rawPixelsSync();
  return { width, pixels, channels: pixels.length / (width * height) };
}

/** The share of opaque black pixels inside a box given in CSS pixels, a pixel in from each edge so rounding never reaches outside it. */
function blackShare(image: Image, box: { x: number; y: number; width: number; height: number }, scale: number): number {
  const left = Math.ceil(box.x * scale) + 1;
  const top = Math.ceil(box.y * scale) + 1;
  const right = Math.floor((box.x + box.width) * scale) - 1;
  const bottom = Math.floor((box.y + box.height) * scale) - 1;
  let black = 0;
  let total = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const at = (row * image.width + column) * image.channels;
      total += 1;
      const opaque = image.channels < 4 || image.pixels[at + 3] === 255;
      if (image.pixels[at] === 0 && image.pixels[at + 1] === 0 && image.pixels[at + 2] === 0 && opaque) black += 1;
    }
  }
  return total === 0 ? 0 : black / total;
}
