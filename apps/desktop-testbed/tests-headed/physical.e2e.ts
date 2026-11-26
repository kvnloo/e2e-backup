import { test } from '@e2e-dev/desktop';
import { expect } from 'e2e';

test.describe('physical input', () => {
  test.beforeEach(async ({ app, screen, desktop }) => {
    await app.open();
    await screen.getByRole('button', 'Controls…').tap();
    await expect.poll(async () => (await desktop.windows()).map((window) => window.title).toSorted()).toEqual(['Controls', 'Sign In']);
    await desktop.useWindow((await desktop.windows()).find((window) => window.title === 'Controls'));
  });

  test('double-clicks a control with the real pointer', async ({ screen }) => {
    await screen.getByRole('button', 'Double-click me').doubleTap();
    await expect(screen.getByTestId('controls-status')).toHaveText('Double-clicked');
  });

  test('hovers a view with the real pointer', async ({ screen }) => {
    await screen.getByTestId('hover').hover();
    await expect(screen.getByTestId('controls-status')).toHaveText('Hovered');
  });

  test('taps a point in the window and types through the real keyboard', async ({ screen }) => {
    const note = screen.getByRole('textbox', 'Note');
    const box = await note.boundingBox();
    expect(box).not.toBeNull();
    await screen.tapAt({ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    // The tap put focus in the field: typing below would focus it by itself, and pass whether the tap landed or not.
    await expect(note).toBeFocused();
    await note.pressSequentially('by hand');
    await note.press('Enter');
    await expect(screen.getByTestId('controls-status')).toHaveText('Submitted: by hand');
  });
});
