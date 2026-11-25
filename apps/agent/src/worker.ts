import type { ClaimedJob, CompleteJobRequest, CompleteJobResponse, FailJobRequest } from '@last-orders/engine';
import type { ModelAdapter } from './adapters/types.js';
import { buildSuspectPrompt } from './prompt.js';

export class AppApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`app API ${status} ${code}`);
    this.name = 'AppApiError';
  }
}

/** Client for the app's internal agent API. */
export class AppClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private async post<T>(path: string, body: unknown): Promise<{ status: number; data: T | null }> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
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

  async process(job: ClaimedJob): Promise<CompleteJobResponse | null> {
    const adapter = job.simulatedOnly ? this.opts.fallback : this.opts.adapter;
    try {
      const prompt = buildSuspectPrompt(job.context);
      const reply = await adapter.reply(prompt, job.context);
      const result = await this.opts.client.complete(job.id, {
        leaseToken: job.leaseToken,
        output: { text: reply.text },
        simulated: reply.simulated,
        usage: reply.usage,
      });
      this.log(`job ${job.id}: ${result.status}`);
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
