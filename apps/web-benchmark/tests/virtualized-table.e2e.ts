import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

/**
 * The Golden Row is row index 4321 at 36 px a row, 155 556 px down a 480 px
 * viewport. A scroll step on the table moves 0.65 of its height (312 px), so
 * it takes about 499 strides to reach it. No row passes unseen, because a
 * stride is shorter than the viewport. The scroll took 17 s on an M-series
 * Mac, about 34 ms a stride. The timeout leaves room for a CI box several
 * times slower, so a slow box fails the scroll and not the attempt. The
 * attempt gets the default budget on top for opening and claiming.
 */
const SCROLL_TIMEOUT_MS = 140_000;

test(
  'scrolls the windowed table to the Golden Row and claims it',
  { timeout: SCROLL_TIMEOUT_MS + 30_000 },
  async ({ app, screen }) => {
    await app.open('/e/virtualized-table');
    const viewport = screen.getByTestId('table-viewport');
    const rows = viewport.getByTestId('table-row');
    const claim = screen.getByRole('button', 'Claim');
    await expect(rows.first()).toHaveText('Row 1');
    await expect(claim).toBeHidden();

    // The table is its own scroll container, so the table pages, not the page.
    await viewport.scrollUntilVisible(claim, { timeout: SCROLL_TIMEOUT_MS });

    await expect(rows.filter({ hasText: 'Golden Row' })).toHaveText(/^Row 4322/);
    await expect(rows.filter({ hasText: 'Row 1' })).toHaveCount(0);
    await claim.tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Golden Row claimed');
  },
);
