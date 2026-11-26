import { type Dispatcher, fetch as undiciFetch } from 'undici';
import type { ClaimedJob, CompleteJobRequest, CompleteJobResponse, FailJobRequest } from '@last-orders/engine';
import type { ModelAdapter } from './adapters/types.js';
import { createShortKeepAliveDispatcher } from './http.js';
import { buildCommentaryPrompt, buildGmPrompt, buildSuspectPrompt } from './prompt.js';

export class AppApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`app API ${status} ${code}`);
    this.name = 'AppApiError';
  }
}

export interface AppClientOptions {
  /** Per-attempt request timeout in ms (default 10 s). */
  timeoutMs?: number;
  /** Creates the connection pool used for app calls (default: short keep-alive undici Agent). */
  createDispatcher?: () => Dispatcher;
  log?: (msg: string) => void;
}

/** Connection pool for app calls: see {@link createShortKeepAliveDispatcher}. */
export function createAppDispatcher(): Dispatcher {
  return createShortKeepAliveDispatcher();
}

/** Client for the app's internal agent API. */
export class AppClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly createDispatcher: () => Dispatcher;
  private readonly log: (msg: string) => void;
  private dispatcher: Dispatcher;

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    fetchImpl?: typeof fetch,
    opts: AppClientOptions = {},
  ) {
    // undici's own fetch, so the dispatcher comes from the same undici version as the fetch.
    this.fetchImpl = fetchImpl ?? (undiciFetch as unknown as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.createDispatcher = opts.createDispatcher ?? createAppDispatcher;
    this.log = opts.log ?? (() => {});
    this.dispatcher = this.createDispatcher();
  }

  /** Drop the current pool (and any dead sockets in it) and start a fresh one. */
  private resetDispatcher(): void {
    const old = this.dispatcher;
    this.dispatcher = this.createDispatcher();
    old.destroy().catch(() => {});
  }

  private send(url: URL, body: string): Promise<Response> {
    const init = {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
      dispatcher: this.dispatcher,
    };
    return this.fetchImpl(url, init as unknown as RequestInit);
  }

  private async post<T>(path: string, body: unknown): Promise<{ status: number; data: T | null }> {
    const url = new URL(path, this.baseUrl);
    const payload = JSON.stringify(body ?? {});
    let res: Response;
    try {
      res = await this.send(url, payload);
    } catch (err) {
      // Timeout or network error (never an HTTP error response): the pooled connection may be
      // dead, so retry once on a fresh pool.
      this.log(`app request ${path} failed (${(err as Error).message}); retrying on a fresh connection`);
      this.resetDispatcher();
      res = await this.send(url, payload);
    }
    if (res.status === 204) return { status: 204, data: null };
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) throw new AppApiError(res.status, data?.error ?? 'unknown');
    return { status: res.status, data };
  }

  async claim(): Promise<ClaimedJob | null> {
    return (await this.post<ClaimedJob>('/internal/agent/jobs/claim', {})).data;
  }

  async complete(id: string, body: CompleteJobRequest): Promise<CompleteJobResponse> {
    return (await this.post<CompleteJobResponse>(`/internal/agent/jobs/${id}/complete`, body)).data!;
  }

  async fail(id: string, body: FailJobRequest): Promise<void> {
    await this.post(`/internal/agent/jobs/${id}/fail`, body);
  }
}

export interface WorkerOptions {
  client: AppClient;
  adapter: ModelAdapter;
  /** Used when the app marks a job simulated-only (spend cap reached). */
  fallback: ModelAdapter;
  log?: (msg: string) => void;
}

/**
 * Drains the app's job queue: claim, build the prompt from the scoped context, call the model,
 * submit. Stops when no job is available. `wake()` during a drain schedules one more pass.
 */
export class Worker {
  private draining: Promise<number> | null = null;
  private again = false;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: WorkerOptions) {
    this.log = opts.log ?? (() => {});
  }

  get busy(): boolean {
    return this.draining !== null;
  }

  /** Start draining, or schedule another pass if a drain is running. */
  wake(): Promise<number> {
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      let total = 0;
      try {
        do {
          this.again = false;
          total += await this.drainOnce();
        } while (this.again);
      } finally {
        this.draining = null;
      }
      return total;
    })();
    return this.draining;
  }

  /** Process jobs until the queue is empty. Returns how many were processed. */
  async drainOnce(): Promise<number> {
    let n = 0;
    for (;;) {
      let job: ClaimedJob | null;
      try {
        job = await this.opts.client.claim();
      } catch (err) {
        this.log(`claim failed: ${(err as Error).message}`);
        return n;
      }
      if (!job) return n;
      await this.process(job);
      n++;
    }
  }

  /** Run one job through the model and submit the result. */
  async run(job: ClaimedJob, adapter: ModelAdapter): Promise<Omit<CompleteJobRequest, 'leaseToken'>> {
    switch (job.kind) {
      case 'suspect_reply': {
        const r = await adapter.reply(buildSuspectPrompt(job.context), job.context);
        return { output: { text: r.text }, simulated: r.simulated, usage: r.usage };
      }
      case 'gm_tick': {
        const r = await adapter.chooseIntervention(buildGmPrompt(job.context), job.context);
        return { output: { choice_id: r.choice_id, reason: r.reason }, simulated: r.simulated, usage: r.usage };
      }
      case 'reveal_commentary': {
        const r = await adapter.commentary(buildCommentaryPrompt(job.context), job.context);
        return { output: { text: r.text }, simulated: r.simulated, usage: r.usage };
      }
    }
  }

  async process(job: ClaimedJob): Promise<CompleteJobResponse | null> {
    const adapter = job.simulatedOnly ? this.opts.fallback : this.opts.adapter;
    try {
      const out = await this.run(job, adapter);
      const result = await this.opts.client.complete(job.id, { leaseToken: job.leaseToken, ...out });
      this.log(`job ${job.id} (${job.kind}): ${result.status}`);
      return result;
    } catch (err) {
      if (err instanceof AppApiError && err.status === 409) {
        this.log(`job ${job.id}: lease lost (${err.code})`);
        return null;
      }
      this.log(`job ${job.id} failed: ${(err as Error).message}`);
      await this.opts.client
        .fail(job.id, { leaseToken: job.leaseToken, error: String((err as Error).message).slice(0, 500) })
        .catch((e: Error) => this.log(`reporting failure for job ${job.id} failed: ${e.message}`));
      return null;
    }
  }
}
