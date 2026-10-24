import { Worker } from "node:worker_threads";
import { codedError } from "./error-codes.mjs";

// One in-flight read per reader; slow/locked external SQLite never blocks the
// HTTP event loop. The worker only uses the existing read-only view adapter.
export function createCronReader({ dir, timeoutMs = 5000 }) {
  let pending;
  return function read() {
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./cron-worker.mjs", import.meta.url), { workerData: { dir } });
      const timer = setTimeout(() => {
        reject(codedError("Koşular okunurken zaman aşımı.", "CRON_READ_TIMEOUT"));
        void worker.terminate();
      }, timeoutMs);
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", code => {
        clearTimeout(timer);
        reject(codedError(`Koşular okuyucusu sonuç üretmeden kapandı (${code}).`, "CRON_READER_EXITED"));
      });
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
