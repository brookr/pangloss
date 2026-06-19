/**
 * Process-wide cleanup registry. Long fusion runs spin up expensive resources
 * (per-agent Docker Compose stacks). If the process is interrupted (Ctrl-C, a
 * kill from a parent harness), the per-agent `finally` blocks never run and the
 * stacks leak — holding ports and containers. Resources register a teardown here
 * and the signal handler runs them all before exiting.
 */

type CleanupFn = () => Promise<void> | void;

const pending = new Set<CleanupFn>();
let installed = false;

/** Register a teardown; returns an unregister to call on normal completion. */
export function onCleanup(fn: CleanupFn): () => void {
  pending.add(fn);
  return () => pending.delete(fn);
}

/** Run (and clear) every pending cleanup, never throwing. */
export async function runCleanups(): Promise<void> {
  const fns = [...pending];
  pending.clear();
  await Promise.allSettled(fns.map((f) => Promise.resolve().then(f)));
}

export function pendingCleanupCount(): number {
  return pending.size;
}

/** Install SIGINT/SIGTERM handlers once: tear down registered resources, then exit. */
export function installSignalCleanup(log?: (msg: string) => void): void {
  if (installed) return;
  installed = true;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      const n = pending.size;
      if (n) log?.(`\n${sig} received — tearing down ${n} resource(s) before exit…`);
      void runCleanups().finally(() => process.exit(130));
    });
  }
}
