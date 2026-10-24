// Bound pending terminal frames while preserving their arrival order across
// asynchronous authorization. A closed/failed connection never drains input.
import { codedError } from "./error-codes.mjs";

export function orderedMessages({ open, handle, fail, maxPending = 256 }) {
  let queue = Promise.resolve(), pending = 0, failed = false;
  const active = () => !failed && open();
  function stop(error) {
    if (failed) return;
    failed = true;
    try { fail(error); } catch { /* The connection may already be gone. */ }
  }
  return raw => {
    if (!active()) return queue;
    if (pending >= maxPending) {
      stop(codedError("Terminal girdi kuyruğu doldu.", "TERMINAL_QUEUE_FULL"));
      return queue;
    }
    pending++;
    queue = queue.then(async () => {
      if (active()) await handle(raw, active);
    }).catch(stop).finally(() => { pending--; });
    return queue;
  };
}
