/** A writer-priority maintenance barrier; incoming QQ messages never use it. */
export class AgentTaskGate {
  constructor() {
    this.active = 0;
    this.waiting = 0;
    this.exclusivePending = 0;
    this.exclusiveRunning = false;
    this.tail = Promise.resolve();
    this.unblocked = null;
    this.releaseUnblocked = null;
    this.drained = null;
    this.releaseDrained = null;
  }

  get blocked() { return this.exclusivePending > 0; }

  tryEnter() {
    if (this.blocked) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (!this.active) {
        this.releaseDrained?.();
        this.drained = this.releaseDrained = null;
      }
    };
  }

  async wait() {
    this.waiting++;
    try { while (this.blocked) await this.unblocked; }
    finally { this.waiting--; }
  }

  async shared(task) {
    let release;
    while (!(release = this.tryEnter())) await this.wait();
    try { return await task(); }
    finally { release(); }
  }

  exclusive(task) {
    if (!this.exclusivePending++) {
      this.unblocked = new Promise((resolve) => { this.releaseUnblocked = resolve; });
    }
    const run = this.tail.catch(() => {}).then(async () => {
      if (this.active) {
        this.drained ||= new Promise((resolve) => { this.releaseDrained = resolve; });
        await this.drained;
      }
      this.exclusiveRunning = true;
      try { return await task(); }
      finally { this.exclusiveRunning = false; }
    }).finally(() => {
      if (!--this.exclusivePending) {
        this.releaseUnblocked?.();
        this.unblocked = this.releaseUnblocked = null;
      }
    });
    this.tail = run.catch(() => {});
    return run;
  }

  snapshot() {
    return { blocked: this.blocked, running: this.exclusiveRunning, activeTasks: this.active, queuedTasks: this.waiting };
  }
}
