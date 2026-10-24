import { PanelError } from "./session-store.mjs";

// The API's single creation boundary covers terminals and every chat provider.
// Reserve before any asynchronous liveness check, without serializing starts
// in unrelated projects. Failed starts release their reservation for retry.
export class SessionCreation {
  constructor({ list, findExisting, create }) {
    Object.assign(this, { list, findExisting, create });
    this.pending = new Map();
  }

  run(input) {
    const { projectId, allowParallel = false } = input;
    if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId))
      return Promise.reject(new PanelError(400, "Geçersiz işlem kimliği."));
    if (typeof allowParallel !== "boolean")
      return Promise.reject(new PanelError(400, "Geçersiz paralel çalışma seçimi."));
    const key = JSON.stringify([input.kind ?? "terminal", input.agentId, input.requestId]);
    if (this.pending.has(key)) return this.pending.get(key).promise;
    const previous = this.findExisting(input);
    if (previous) return Promise.resolve(previous);
    if (!allowParallel && [...this.pending.values()].some(entry => entry.projectId === projectId))
      return Promise.reject(new PanelError(409, "Bu projede oturum açılıyor. Paralel çalışma seçimini onaylayabilirsin."));
    const promise = Promise.resolve().then(async () => {
      const current = await this.list();
      if (!allowParallel && current.some(item => item.projectId === projectId && item.status === "running"))
        throw new PanelError(409, "Bu projede açık session var. Paralel çalışma seçimini onaylayabilirsin.");
      return this.create(input);
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, { projectId, promise });
    return promise;
  }
}
