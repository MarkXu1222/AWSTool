/** One active browser operation; manual-wait sessions retain their browser without owning this slot. */
export class RootEmailExecutionSlot {
  private owner?: string;
  private waiting: Array<{ id: string; grant: () => void }> = [];
  get busy() { return this.owner !== undefined; }

  tryAcquire(id: string): boolean {
    if (this.owner !== undefined || this.waiting.length) return false;
    this.owner = id;
    return true;
  }

  acquire(id: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.owner === id) return Promise.resolve();
    if (this.tryAcquire(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiting = this.waiting.filter(item => item !== entry);
        reject(signal.reason);
      };
      const entry = { id, grant: () => {
        signal.removeEventListener('abort', onAbort);
        this.owner = id;
        resolve();
      } };
      this.waiting.push(entry);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(id: string): void {
    // An expired parked session must never release another account's active operation.
    if (this.owner !== id) return;
    this.owner = undefined;
    this.waiting.shift()?.grant();
  }
}
