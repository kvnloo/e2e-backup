import { randomUUID } from 'node:crypto';
import { expect } from 'e2e';
import { test } from './fixtures.ts';

test('signing up sends one welcome email', async ({ app, screen, services }) => {
  const address = `ada+${randomUUID()}@example.com`;

  await app.open('/');
  await screen.getByRole('textbox', { name: 'Email' }).fill(address);
  await screen.getByRole('button', { name: 'Sign up' }).click();
  await expect(screen.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

  const sent = await services.email.sent();

  expect(sent.filter((email) => email.to === address)).toEqual([{ to: address, subject: 'Welcome' }]);
});
