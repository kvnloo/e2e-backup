import { test } from '@e2e-dev/desktop';
import { expect } from 'e2e';
import { frontmost, TESTBED_APP } from './frontmost.ts';

/**
 * The controls window: one test per capability the sign-in form does not
 * reach, all without physical input. The engine launches the app in the
 * background and the app does not activate itself, so these drive an app
 * that is not in front.
 */
test.describe('controls window', () => {
  test.beforeEach(async ({ app, screen, desktop }) => {
    await app.open();
    await screen.getByRole('button', 'Controls…').tap();
    await expect.poll(async () => (await desktop.windows()).map((window) => window.title).toSorted()).toEqual(['Controls', 'Sign In']);
    const controls = (await desktop.windows()).find((window) => window.title === 'Controls');
    await desktop.useWindow(controls);
  });

  test('scrolls a list until an item shows, and selects it', async ({ screen }) => {
    const last = screen.getByText('Item 40');
    await expect(last).toBeHidden();
    await screen.scrollUntilVisible(last, { direction: 'down' });
    await expect(last).toBeVisible();
    await screen.getByRole('table', 'Items').selectOption('Item 40');
    await expect(screen.getByTestId('controls-status')).toHaveText('Selected Item 40');
  });

  test('finds a row and a cell by the text inside them, and selects a row by tapping its cell', async ({ screen }) => {
    await expect(screen.getByRole('row', 'Item 1')).toBeVisible();
    await expect(screen.getByRole('cell', 'Item 2')).toBeVisible();
    await screen.getByRole('cell', 'Item 2').tap();
    await expect(screen.getByTestId('controls-status')).toHaveText('Selected Item 2');
    // A row takes a tap too: the table selects it, though the row offers no press of its own.
    await screen.getByRole('row', 'Item 3').tap();
    await expect(screen.getByTestId('controls-status')).toHaveText('Selected Item 3');
  });

  test('selects a row of a two-column table by all its text, and refuses a label two rows show', async ({ screen }) => {
    const accounts = screen.getByRole('table', 'Accounts');
    await accounts.selectOption('Checking USD');
    await expect(screen.getByTestId('controls-status')).toHaveText('Selected account 1: Checking USD');
    const refused = await accounts.selectOption('Savings EUR', { timeout: 1_000 }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(String(refused)).toMatch(/more than one option/);
    // Neither alike row was chosen: the status still shows the first choice.
    await expect(screen.getByTestId('controls-status')).toHaveText('Selected account 1: Checking USD');
  });

  test("keeps a content button with the close-button subrole, and leaves out the window's own title-bar buttons", async ({ screen }) => {
    await expect(screen.getByTestId('close-tab')).toBeVisible();
    // The window names its title-bar buttons, and only those are window chrome: none of them is read as a button.
    await expect(screen.getByRole('button', 'Close')).toHaveCount(0);
    await expect(screen.getByRole('button', 'Minimize')).toHaveCount(0);
  });

  test('presses keys into a field of an app in the background, and types into it', async ({ screen }) => {
    // The keys go into the app's own event queue: it must not be the app in front, before or after.
    expect(frontmost()).not.toBe(TESTBED_APP);
    const note = screen.getByRole('textbox', 'Note');
    await note.fill('hello');
    await note.press('Enter');
    await expect(screen.getByTestId('controls-status')).toHaveText('Submitted: hello');
    // Return can leave the text selected, so a second entry starts from an empty field and is checked whole.
    await note.clear();
    await note.pressSequentially('typed');
    await note.press('Enter');
    await expect(screen.getByTestId('controls-status')).toHaveText('Submitted: typed');
    expect(frontmost()).not.toBe(TESTBED_APP);
  });

  test('stops typing when a key opens another window, so the rest of the text does not follow the keyboard there', async ({ screen, desktop }) => {
    const opener = screen.getByRole('textbox', 'Opener');
    // The first character opens the Popup window and moves the keyboard into its field.
    const failure = await opener.pressSequentially('xyz').then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(String(failure)).toMatch(/typing stopped/);
    await expect(opener).toHaveValue('x');
    const popup = (await desktop.windows()).find((window) => window.title === 'Popup');
    await desktop.useWindow(popup);
    await expect(screen.getByRole('textbox', 'Popup field')).toHaveValue('');
  });

  test('stops typing when a key after a Tab opens another window', async ({ screen, desktop }) => {
    // The Tab takes the keyboard from the Note to the Opener, whose first character opens the Popup.
    const failure = await screen
      .getByRole('textbox', 'Note')
      .pressSequentially('ab\txyz')
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(String(failure)).toMatch(/typing stopped/);
    await expect(screen.getByRole('textbox', 'Opener')).toHaveValue('x');
    const popup = (await desktop.windows()).find((window) => window.title === 'Popup');
    await desktop.useWindow(popup);
    await expect(screen.getByRole('textbox', 'Popup field')).toHaveValue('');
  });

  test('reads native tabs as tabs, the active one selected, and switches between them', async ({ screen }) => {
    const first = screen.getByRole('tab', 'First');
    const second = screen.getByRole('tab', 'Second');
    await expect(first).toBeSelected();
    await expect(second).not.toBeSelected();
    await second.tap();
    await expect(second).toBeSelected();
    await expect(first).not.toBeSelected();
    // A tab list selects by label too, and checks the tab shows it is selected.
    await screen.getByRole('tablist').selectOption('First');
    await expect(first).toBeSelected();
  });

  test('types text whose characters take two UTF-16 units each, whole', async ({ screen }) => {
    const note = screen.getByRole('textbox', 'Note');
    // One key event per character, a surrogate pair in one. AppKit would rejoin a split pair, so this checks such text
    // types whole, not how the driver cuts it, which its unit tests cover.
    const text = '123456789012345😀 café 👍🏽';
    await note.pressSequentially(text);
    await expect(note).toHaveValue(text);
  });

  test('opens a context menu and chooses one of its items', async ({ screen }) => {
    await screen.getByRole('button', 'Options').secondaryTap();
    await expect(screen.getByTestId('controls-status')).toHaveText('Context menu opened');
    await screen.getByRole('menuitem', 'Copy').tap();
    await expect(screen.getByTestId('controls-status')).toHaveText('Chose Copy');
  });

  test('sets a slider and reads a disabled button', async ({ screen }) => {
    await screen.getByRole('slider', 'Volume').fill('40');
    await expect(screen.getByRole('slider', 'Volume')).toHaveValue('40');
    // A value set through accessibility does not always fire the control's action: the status line shows the app saw it.
    await expect(screen.getByTestId('controls-status')).toHaveText('Volume 40');
    await expect(screen.getByRole('button', 'Disabled')).toBeDisabled();
    // AppKit acknowledges a press on a disabled button and ignores it: the tap waits for it to be enabled, then fails.
    const refused = await screen
      .getByRole('button', 'Disabled')
      .tap({ timeout: 1_000 })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(String(refused)).toMatch(/disabled/);
  });

  test('waits for a disabled list to be enabled before it selects an option', async ({ screen }) => {
    await expect(screen.getByRole('combobox', 'Size')).toBeDisabled();
    // The app enables the list half a second after this tap: the select starts while it is still disabled.
    await screen.getByRole('button', 'Enable later').tap();
    await screen.getByRole('combobox', 'Size').selectOption('Large');
    await expect(screen.getByRole('combobox', 'Size')).toHaveValue('Large');
  });

  test('waits for a disabled box to be enabled before it checks it', async ({ screen }) => {
    await expect(screen.getByRole('checkbox', 'Agree')).toBeDisabled();
    await screen.getByRole('button', 'Enable later').tap();
    await screen.getByRole('checkbox', 'Agree').check();
    await expect(screen.getByRole('checkbox', 'Agree')).toBeChecked();
  });
});
