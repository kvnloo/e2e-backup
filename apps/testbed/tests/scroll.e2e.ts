import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('scrolling', { requires: ['browser'], tags: ['scroll'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/scroll');
  });

  test('scrollUntilVisible pages the viewport until a row far down renders', async ({ screen }) => {
    const row = screen.getByRole('button', { name: 'Row 100', exact: true });
    await expect(row).toHaveCount(0);

    await screen.scrollUntilVisible(row);
    await expect(screen.getByRole('status', 'Scroll position')).not.toHaveText('0');
    await row.tap();
    await expect(screen.getByRole('status', 'Picked row')).toHaveText('picked Row 100');
  });

  test('scrollUntilVisible on a node pages that node and leaves the page where it was', async ({ screen }) => {
    const pane = screen.getByRole('list', 'Pane');
    const item = screen.getByRole('button', { name: 'Item 40', exact: true });
    await expect(item).toHaveCount(0);

    await pane.scrollUntilVisible(item);
    await expect(screen.getByRole('status', 'Pane position')).not.toHaveText('0');
    await expect(screen.getByRole('status', 'Scroll position')).toHaveText('0');
    await item.tap();
    await expect(screen.getByRole('status', 'Picked row')).toHaveText('picked Item 40');
  });

  test('scrollUntilVisible reaches every row of a long list in turn', async ({ screen }) => {
    const pane = screen.getByRole('list', 'Pane');
    for (let index = 1; index <= 40; index += 1) {
      await pane.scrollUntilVisible(screen.getByRole('button', { name: `Item ${index}`, exact: true }));
    }

    for (let index = 1; index <= 120; index += 1) {
      await screen.scrollUntilVisible(screen.getByRole('button', { name: `Row ${index}`, exact: true }));
    }
  });

  test('a screen swipe scrolls the container under the screen centre, as a wheel there does', async ({ screen, browser }) => {
    const pane = screen.getByRole('status', 'Pane position');
    // The pane is under the screen's centre, so it scrolls half of its 200 px. The page doesn't scroll.
    await screen.swipe({ direction: 'down' });
    await expect(pane).toHaveText('100');
    await expect(screen.getByRole('status', 'Scroll position')).toHaveText('0');

    await browser.mouse.wheel(0, 600);
    await expect(pane).toHaveText('700');

    await screen.swipe({ direction: 'up' });
    await expect(pane).toHaveText('600');
  });

  test('a node swipe scrolls only inside a scrollable node', async ({ screen }) => {
    await screen.getByRole('list', 'Pane').swipe({ direction: 'down', distance: 0.25 });
    await expect(screen.getByRole('status', 'Pane position')).not.toHaveText('0');
    await expect(screen.getByRole('status', 'Scroll position')).toHaveText('0');
  });
});
