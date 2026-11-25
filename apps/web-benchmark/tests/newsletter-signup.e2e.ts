import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('subscribe renders no feedback and logs a TypeError (planted bug)', async ({ app, screen, browser }) => {
  await app.open('/e/newsletter-signup');
  const email = screen.getByPlaceholder('you@example.com');
  await email.fill('maria.novak@example.com');
  await screen.getByRole('button', 'Subscribe').tap();

  await expect(screen.getByTestId('success-message')).not.toBeVisible();
  await expect(screen.getByTestId('error-message')).not.toBeVisible();
  await expect(email).toHaveValue('maria.novak@example.com');
  await expect.poll(async () => {
    const messages = await browser.consoleMessages();

    return messages
      .filter((message) => message.type === 'error')
      .map((message) => message.text)
      .join('\n');
  }).toContain("Cannot read properties of undefined (reading 'subscribe')");
});
