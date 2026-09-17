const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function parseShutdownTimeout(value = process.env.MCP_SHUTDOWN_TIMEOUT_MS) {
  if (value === undefined || value === "") return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!/^\d+$/.test(value) || Number(value) < 1_000 || Number(value) > 2_147_483_647 || !Number.isSafeInteger(Number(value))) {
    throw new Error("MCP_SHUTDOWN_TIMEOUT_MS must be a safe integer of at least 1000 and at most 2147483647");
  }
  return Number(value);
}

export async function runBoundedShutdown({ tasks, timeoutMs, force, closeDatabase, logError }) {
  let timer;
  const resultsPromise = Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  const outcome = await Promise.race([
    resultsPromise.then((results) => ({ timedOut: false, results })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true, results: [] }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);

  let failed = outcome.timedOut;
  if (outcome.timedOut) {
    logError(`Graceful shutdown exceeded ${timeoutMs}ms; forcing connections closed.`);
    try {
      force?.();
    } catch (error) {
      logError(`Forced connection cleanup failed: ${error.message}`);
    }
  } else {
    for (const result of outcome.results) {
      if (result.status === "rejected") {
        failed = true;
        logError(`Graceful shutdown task failed: ${result.reason?.message || result.reason}`);
      }
    }
  }

  try {
    closeDatabase();
  } catch (error) {
    failed = true;
    logError(`Database shutdown failed: ${error.message}`);
  }
  return !failed;
}
