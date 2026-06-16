/**
 * Run `fn` over `items` with at most `limit` in flight. Preserves input order
 * in the result array. Rejections propagate (callers that want
 * fault-tolerance should catch inside `fn`).
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
