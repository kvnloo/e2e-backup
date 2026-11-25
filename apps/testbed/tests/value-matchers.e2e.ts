import { expect, test } from 'e2e';

class Order {
  constructor(readonly id: number) {}
}
class PaymentError extends Error {}
function declined(): never {
  throw new PaymentError('card declined');
}

test('the unit-style value matchers run in a test, awaited forms included', async ({ request }) => {
  expect(new Order(1)).toStrictEqual(new Order(1));
  expect(new Order(1)).not.toStrictEqual({ id: 1 });
  expect([{ sku: 'a' }]).toContainEqual({ sku: 'a' });
  expect(new PaymentError('x')).toBeInstanceOf(Error);
  expect(declined).toThrow('declined');
  expect(declined).toThrow(/^card/);
  expect(declined).toThrow(PaymentError);
  expect(declined).toThrow(new Error('card declined'));
  expect(() => 1).not.toThrow();
  expect({ total: 0.1 + 0.2 }).toEqual({ total: expect.closeTo(0.3) });
  await expect(request.get('/api/users')).resolves.toBeOK();
  await expect(Promise.resolve(1)).resolves.not.toBe(2);
  await expect(Promise.reject(new PaymentError('card declined'))).rejects.toThrow('declined');
  await expect.poll(() => [{ sku: 'a' }]).toContainEqual({ sku: 'a' });
});
