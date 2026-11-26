import { test } from '@e2e-dev/desktop';
import { expect } from 'e2e';

/**
 * The controls window: one test per capability the sign-in form does not
 * reach, all without physical input, so the app stays in the background.
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

  test('presses keys into a field of an app in the background', async ({ screen }) => {
    const note = screen.getByRole('textbox', 'Note');
    await note.fill('hello');
    await note.press('Enter');
    await expect(screen.getByTestId('controls-status')).toHaveText('Submitted: hello');
    // Return can leave the text selected, so a second entry starts from an empty field and is checked whole.
    await note.clear();
    await note.pressSequentially('typed');
    await note.press('Enter');
    await expect(screen.getByTestId('controls-status')).toHaveText('Submitted: typed');
  });

  test('types text whose characters take two UTF-16 units each, whole', async ({ screen }) => {
    const note = screen.getByRole('textbox', 'Note');
    // The 16th unit is the first half of the emoji, where key events would split it. AppKit rejoins a split pair, so this
    // passes either way: it checks such text types whole, not the driver's boundary rule, which its unit tests cover.
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
  });
});
