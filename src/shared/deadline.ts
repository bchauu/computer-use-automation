/** Shared clock bookkeeping; callers decide what to do when time expires. */
export class Deadline {
  private readonly expiresAt: number;

  constructor(timeoutMs: number) {
    this.expiresAt = Date.now() + timeoutMs;
  }

  get expired() {
    return Date.now() >= this.expiresAt;
  }

  get remainingMs() {
    return Math.max(0, this.expiresAt - Date.now());
  }
}
