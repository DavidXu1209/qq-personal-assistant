/** Coalesce display updates only; never schedules, merges or consumes Agent tasks. */
export class TargetUpdateStream {
  constructor({ emit, delayMs = 100, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { emit, delayMs, schedule, cancel });
    this.keys = new Set();
    this.timer = null;
  }
  queue(key) {
    if (!key) return;
    this.keys.add(key);
    if (this.timer !== null) return;
    this.timer = this.schedule(() => this.flush(), this.delayMs);
    this.timer?.unref?.();
  }
  flush() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    if (!this.keys.size) return;
    const keys = [...this.keys];
    this.keys.clear();
    this.emit(keys);
  }
}
