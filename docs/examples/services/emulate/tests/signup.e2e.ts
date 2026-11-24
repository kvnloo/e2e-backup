import { expect } from 'e2e';
import { test } from './fixtures.ts';

test.beforeEach(async ({ services }) => {
  await services.resend.reset();
});

test('signing up sends a welcome email through Resend', async ({ app, screen, services }) => {
  await app.open('/');
  await screen.getByRole('textbox', { name: 'Email' }).fill('ada@example.com');
  await screen.getByRole('button', { name: 'Sign up' }).click();
  await expect(screen.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

  const response = await fetch(`${services.resend.url}/emails`);
  const { data } = await response.json();

  expect(data).toEqual([expect.objectContaining({ to: ['ada@example.com'], subject: 'Welcome' })]);
});
