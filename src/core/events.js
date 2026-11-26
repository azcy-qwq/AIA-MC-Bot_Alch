export class EventBus {
  #listeners = new Map();

  on(type, listener) {
    const listeners = this.#listeners.get(type) || new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  emit(type, payload) {
    for (const listener of this.#listeners.get(type) || []) {
      try {
        listener(payload);
      } catch (error) {
        this.emit("error", { source: type, error });
      }
    }
  }
}

export class EventCursor {
  #lastSeq = 0;

  get lastSeq() { return this.#lastSeq; }

  accept(result = {}) {
    if (Number.isFinite(result.last_seq)) this.#lastSeq = result.last_seq;
    return result.events || [];
  }
}
