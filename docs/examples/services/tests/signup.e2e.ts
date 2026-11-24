import { expect } from 'e2e';
import { test } from './fixtures.ts';

test.beforeEach(async ({ services }) => {
  await services.email.clear();
});

test('signing up sends one welcome email', async ({ app, screen, services }) => {
  await app.open('/');
  await screen.getByRole('textbox', { name: 'Email' }).fill('ada@example.com');
  await screen.getByRole('button', { name: 'Sign up' }).click();
  await expect(screen.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

  expect(await services.email.sent()).toEqual([{ to: 'ada@example.com', subject: 'Welcome' }]);
});
