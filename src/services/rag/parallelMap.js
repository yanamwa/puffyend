export async function parallelMap(items, limit, task) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit.');
  const results = new Array(items.length);
  let next = 0, failure;
  async function worker() {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index], index); }
      catch (error) { failure ||= error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return results;
}
