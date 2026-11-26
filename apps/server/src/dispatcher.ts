import type { JobQueue } from './jobs.js';

export interface DispatcherOptions {
  /** Agent wake endpoint. Empty: never ping. */
  wakeUrl: string;
  intervalMs: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
  /**
   * Periodic game upkeep run on every pass before the queue is checked: timed act changes and
   * game-master ticks. Returns how many jobs it enqueued.
   */
  periodic?: () => Promise<number>;
}

export interface TickResult {
  requeued: number;
  /** Jobs enqueued by the periodic game upkeep. */
  enqueued: number;
  pending: number;
  pinged: boolean;
}

/**
 * Keeps jobs moving. Each tick runs the periodic game upkeep, returns expired leases to the
 * queue and, while pending jobs exist, pings the agent's wake URL. Repeated pings back off exponentially until the queue
 * empties; new work (`kick`) pings at once.
 */
export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<TickResult> | null = null;
  private rerun = false;
  private nextPingAt = 0;
  private backoffMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly jobs: JobQueue,
    private readonly opts: DispatcherOptions,
  ) {
    this.minBackoffMs = opts.minBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.backoffMs = this.minBackoffMs;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick().catch((e: Error) => this.log(`tick failed: ${e.message}`)),
      this.opts.intervalMs,
    );
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** New work exists: ping now, ignoring backoff. */
  kick() {
    this.nextPingAt = 0;
    this.backoffMs = this.minBackoffMs;
    void this.tick().catch((e: Error) => this.log(`tick failed: ${e.message}`));
  }

  /** One dispatcher pass. Concurrent calls coalesce into one extra pass. */
  async tick(): Promise<TickResult> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.pass();
    try {
      let result = await this.running;
      while (this.rerun) {
        this.rerun = false;
        this.running = this.pass();
        result = await this.running;
      }
      return result;
    } finally {
      this.running = null;
    }
  }

  private async pass(): Promise<TickResult> {
    let enqueued = 0;
    if (this.opts.periodic) {
      try {
        enqueued = await this.opts.periodic();
      } catch (err) {
        this.log(`game upkeep failed: ${(err as Error).message}`);
      }
      // New work: ping now rather than waiting out the backoff.
      if (enqueued) {
        this.nextPingAt = 0;
        this.backoffMs = this.minBackoffMs;
      }
    }
    const requeued = await this.jobs.requeueExpired();
    if (requeued) this.log(`requeued ${requeued} expired job(s)`);
    const pending = await this.jobs.pendingCount();
    if (pending === 0) {
      this.backoffMs = this.minBackoffMs;
      this.nextPingAt = 0;
      return { requeued, enqueued, pending, pinged: false };
    }
    if (!this.opts.wakeUrl || this.now() < this.nextPingAt) return { requeued, enqueued, pending, pinged: false };
    const ok = await this.ping();
    this.nextPingAt = this.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    return { requeued, enqueued, pending, pinged: ok };
  }

  private async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.opts.wakeUrl, {
        method: 'POST',
        // A sleeping Sprite took 5.6 s to answer its first request (infra/sprite/FINDINGS.md).
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok;
    } catch (err) {
      this.log(`wake ping failed: ${(err as Error).message}`);
      return false;
    }
  }
}
