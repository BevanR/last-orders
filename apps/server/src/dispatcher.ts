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
  /** Longest time a wake request is held open while the agent works (default 5 minutes). */
  wakeHoldMs?: number;
}

/** A sleeping Sprite took 5.6 s to answer its first request (infra/sprite/FINDINGS.md). */
const WAKE_PING_TIMEOUT_MS = 15_000;
/** One cold wake took about 4 minutes (26 November 2026). A pre-warm ping waits that long. */
const PREWARM_TIMEOUT_MS = 300_000;
/**
 * The agent answers `POST /wake` at once but keeps the response open until its drain is done,
 * because the Sprite is suspended when no request to it is open, even while the agent is waiting
 * on the app or the model (infra/sprite/FINDINGS.md). The app keeps reading that response, so
 * the Sprite stays awake, for up to this long. It exceeds the agent's worst case for one job
 * (about 80 s) several times over.
 */
const WAKE_HOLD_MS = 300_000;

export interface TickResult {
  requeued: number;
  /** Jobs enqueued by the periodic game upkeep. */
  enqueued: number;
  pending: number;
  pinged: boolean;
}

/**
 * Keeps jobs moving. Each tick runs the periodic game upkeep, returns expired leases to the
 * queue and, while pending jobs exist, pings the agent's wake URL. Repeated pings back off
 * exponentially until the queue empties; new work (`kick`) pings at once. `prewarm` pings once
 * with no work queued, so a sleeping agent is awake before the first job arrives.
 */
export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<TickResult> | null = null;
  private rerun = false;
  private nextPingAt = 0;
  private warming: Promise<boolean> | null = null;
  private backoffMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly wakeHoldMs: number;

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
    this.wakeHoldMs = opts.wakeHoldMs ?? WAKE_HOLD_MS;
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

  /**
   * Wake the agent ahead of work, for example when a room is created. Fire-and-forget: it never
   * throws or blocks the caller. At most one pre-warm ping is in flight per process. Does nothing
   * when no wake URL is set.
   */
  prewarm(): void {
    if (!this.opts.wakeUrl || this.warming) return;
    const started = this.now();
    this.warming = this.ping(PREWARM_TIMEOUT_MS)
      .then((ok) => {
        if (ok) this.log(`pre-warm ping answered in ${this.now() - started} ms`);
        return ok;
      })
      .finally(() => {
        this.warming = null;
      });
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
    const ok = await this.ping(WAKE_PING_TIMEOUT_MS);
    this.nextPingAt = this.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    return { requeued, enqueued, pending, pinged: ok };
  }

  /**
   * POST the wake URL. Resolves true once the agent answers (response headers), false on an
   * error or when no answer comes within `timeoutMs`. The request itself stays open after that,
   * up to `wakeHoldMs`: the response body is read until the agent ends it (its drain is done).
   * An open request is what keeps the Sprite awake while the agent works. A request with no
   * answer yet is kept too, in case a proxy holds the headers back until the body is complete.
   */
  private ping(timeoutMs: number): Promise<boolean> {
    const ac = new AbortController();
    const hold = setTimeout(() => ac.abort(new Error('wake hold limit reached')), this.wakeHoldMs);
    hold.unref?.();
    const request = this.fetchImpl(this.opts.wakeUrl, { method: 'POST', signal: ac.signal });
    void request
      .then(async (res) => {
        if (!res.body) return;
        const reader = res.body.getReader();
        while (!(await reader.read()).done);
      })
      .catch(() => {})
      .finally(() => clearTimeout(hold));
    let timer: NodeJS.Timeout | undefined;
    const answered = request.then(
      (res) => res.ok,
      (err: Error) => {
        this.log(`wake ping failed: ${err.message}`);
        return false;
      },
    );
    const noAnswer = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        this.log(`wake ping failed: no answer within ${timeoutMs} ms`);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    });
    return Promise.race([answered, noAnswer]).finally(() => clearTimeout(timer));
  }
}
