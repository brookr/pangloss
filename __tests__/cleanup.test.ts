import { onCleanup, runCleanups, pendingCleanupCount } from '../src/cleanup.js';

describe('cleanup registry', () => {
  it('runs registered cleanups, clears them, and tolerates throwers', async () => {
    const order: string[] = [];
    onCleanup(() => {
      order.push('a');
    });
    onCleanup(async () => {
      order.push('b');
    });
    onCleanup(() => {
      throw new Error('boom'); // must not break the others
    });
    expect(pendingCleanupCount()).toBe(3);

    await expect(runCleanups()).resolves.toBeUndefined();
    expect(order.sort()).toEqual(['a', 'b']);
    expect(pendingCleanupCount()).toBe(0);
  });

  it('unregister removes a pending cleanup', async () => {
    const ran: string[] = [];
    const off = onCleanup(() => {
      ran.push('x');
    });
    off();
    await runCleanups();
    expect(ran).toEqual([]);
  });
});
