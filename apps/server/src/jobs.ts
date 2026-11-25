import { buildSuspectContext, type ClaimedJob, type CompleteJobResponse } from '@last-orders/engine';
import { z } from 'zod';
import type { CaseStore } from './cases.js';
import { withTx, type Db, type Tx } from './db.js';
import { HttpError } from './errors.js';
import { emit } from './events.js';
import { lockGame, loadState, toMessageDto, type MessageRow } from './store.js';

export interface JobRow {
  id: string;
  game_id: string;
  player_id: string | null;
  kind: string;
  serial_key: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  lease_token: string | null;
  lease_expires_at: Date | null;
  attempts: number;
  idempotency_key: string;
  input_revision: number | null;
  payload: SuspectReplyPayload;
  result: unknown;
}

export interface SuspectReplyPayload {
  interviewId: string;
  suspectId: string;
  triggerMessageId: string;
  transitionId: string | null;
}

export const CompleteBodySchema = z.object({
  leaseToken: z.string().uuid(),
  output: z.object({ text: z.string().max(8_000) }),
  simulated: z.boolean(),
  usage: z
    .object({
      model: z.string().max(100),
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
    })
    .nullable()
    .default(null),
});
export type CompleteBody = z.infer<typeof CompleteBodySchema>;

export const FailBodySchema = z.object({
  leaseToken: z.string().uuid(),
  error: z.string().max(2_000),
});

export type CompleteResult = CompleteJobResponse;

/** US cents per million tokens: [input, output]. Unknown models are priced as Opus. */
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [10, 50],
  'claude-sonnet-5-5': [200, 1000],
  'claude-opus-5-5': [400, 2000],
};

export function costCents(usage: CompleteBody['usage']): number {
  if (!usage) return 0;
  const [inp, out] = PRICES[usage.model] ?? PRICES['claude-opus-5-5']!;
  return (usage.inputTokens * inp + usage.outputTokens * out) / 1_000_000;
}

const MAX_REPLY_CHARS = 1_200;

/** Model output is untrusted: drop control characters, trim, and cap the length. */
export function cleanReply(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return clean.length > MAX_REPLY_CHARS ? `${clean.slice(0, MAX_REPLY_CHARS - 1)}…` : clean;
}

export interface JobQueueOptions {
  leaseSeconds: number;
  maxAttempts: number;
}

export class JobQueue {
  constructor(
    private readonly db: Db,
    private readonly cases: CaseStore,
    private readonly opts: JobQueueOptions,
  ) {}

  /** Insert a suspect reply job inside the caller's transaction. Idempotent per trigger message. */
  async enqueueSuspectReply(tx: Tx, gameId: string, playerId: string, payload: SuspectReplyPayload): Promise<void> {
    await tx.query(
      `INSERT INTO jobs (game_id, player_id, kind, serial_key, idempotency_key, payload)
       VALUES ($1, $2, 'suspect_reply', $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [gameId, playerId, `${gameId}:${payload.suspectId}`, `msg:${payload.triggerMessageId}`, payload],
    );
  }

  async pendingCount(): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>("SELECT count(*) AS n FROM jobs WHERE status = 'pending'");
    return Number(rows[0]!.n);
  }

  /**
   * Lease the oldest pending job whose serial key has no running job and no older pending job.
   * The partial unique index on running serial keys settles races between claimers.
   */
  async claim(): Promise<ClaimedJob | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await withTx(this.db, (tx) => this.claimOnce(tx));
      } catch (err) {
        if ((err as { code?: string }).code === '23505') continue;
        throw err;
      }
    }
    return null;
  }

  private async claimOnce(tx: Tx): Promise<ClaimedJob | null> {
    const { rows } = await tx.query<JobRow>(
      `UPDATE jobs
          SET status = 'running',
              lease_token = gen_random_uuid(),
              lease_expires_at = now() + make_interval(secs => $1),
              attempts = attempts + 1,
              updated_at = now()
        WHERE id = (
          SELECT j.id FROM jobs j
           WHERE j.status = 'pending'
             AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.serial_key = j.serial_key AND r.status = 'running')
             AND NOT EXISTS (SELECT 1 FROM jobs o WHERE o.serial_key = j.serial_key AND o.status = 'pending' AND o.id < j.id)
           ORDER BY j.id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [this.opts.leaseSeconds],
    );
    const job = rows[0];
    if (!job) return null;
    const { context, revision, simulatedOnly } = await this.buildContext(tx, job);
    await tx.query('UPDATE jobs SET input_revision = $2 WHERE id = $1', [job.id, revision]);
    return {
      id: String(job.id),
      kind: 'suspect_reply',
      leaseToken: job.lease_token!,
      leaseExpiresAt: job.lease_expires_at!.toISOString(),
      attempt: job.attempts,
      simulatedOnly,
      context,
    };
  }

  private async buildContext(tx: Tx, job: JobRow) {
    const p = job.payload;
    const { rows: games } = await tx.query('SELECT * FROM games WHERE id = $1', [job.game_id]);
    const game = games[0];
    const c = await this.cases.get(game.case_version_id);
    const state = await loadState(tx, game);
    const { rows: rev } = await tx.query<{ revision: number }>(
      'SELECT revision FROM suspect_states WHERE game_id = $1 AND suspect_id = $2',
      [job.game_id, p.suspectId],
    );
    // The last 40 messages up to the trigger, oldest first.
    const { rows: history } = await tx.query<MessageRow>(
      `SELECT * FROM (
         SELECT * FROM messages WHERE interview_id = $1 AND id <= $2 ORDER BY id DESC LIMIT 40
       ) h ORDER BY id`,
      [p.interviewId, p.triggerMessageId],
    );
    const context = buildSuspectContext(c, state, p.suspectId, {
      history: history.map((m) => ({
        role: m.role,
        text: m.text,
        presentedEvidenceId: m.presented_evidence_id,
      })),
      firedTransitionId: p.transitionId,
    });
    return {
      context,
      revision: rev[0]?.revision ?? 0,
      simulatedOnly: Number(game.spend_cents) >= game.spend_cap_cents,
    };
  }

  /**
   * Accept an agent's result. Idempotent: completing a finished job returns the stored result
   * and writes nothing. A result built from an out-of-date suspect state is discarded and the
   * job requeued so it is rebuilt with fresh context.
   */
  async complete(jobId: string, body: CompleteBody): Promise<CompleteResult> {
    return withTx(this.db, async (tx) => {
      const { rows } = await tx.query<JobRow & { expired: boolean }>(
        'SELECT *, lease_expires_at <= now() AS expired FROM jobs WHERE id = $1 FOR UPDATE',
        [jobId],
      );
      const job = rows[0];
      if (!job) throw new HttpError(404, 'job_not_found');
      if (job.status === 'done') {
        const r = job.result as { messageId: string };
        return { status: 'done', duplicate: true, messageId: r.messageId };
      }
      if (job.status !== 'running' || job.lease_token !== body.leaseToken)
        throw new HttpError(409, 'lease_lost', 'This job is no longer leased to you.');
      if (job.expired) throw new HttpError(409, 'lease_expired', 'The lease has expired.');
      const text = cleanReply(body.output.text);
      if (!text) throw new HttpError(422, 'invalid_output', 'Empty reply.');

      await lockGame(tx, job.game_id);
      const p = job.payload;
      const { rows: rev } = await tx.query<{ revision: number }>(
        'SELECT revision FROM suspect_states WHERE game_id = $1 AND suspect_id = $2',
        [job.game_id, p.suspectId],
      );
      if ((rev[0]?.revision ?? 0) !== job.input_revision) {
        await tx.query(
          `UPDATE jobs SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
                  error = 'stale context', updated_at = now()
            WHERE id = $1`,
          [jobId],
        );
        return { status: 'requeued', reason: 'stale' };
      }

      const inserted = await tx.query<MessageRow>(
        `INSERT INTO messages (interview_id, role, text, job_id, simulated)
         VALUES ($1, 'suspect', $2, $3, $4)
         ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO NOTHING
         RETURNING *`,
        [p.interviewId, text, jobId, body.simulated],
      );
      const message =
        inserted.rows[0] ?? (await tx.query<MessageRow>('SELECT * FROM messages WHERE job_id = $1', [jobId])).rows[0]!;
      await tx.query(
        `UPDATE jobs SET status = 'done', result = $2, usage = $3, lease_token = NULL,
                completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [jobId, { messageId: String(message.id) }, body.usage],
      );
      const cents = costCents(body.usage);
      if (cents > 0)
        await tx.query('UPDATE games SET spend_cents = spend_cents + $2 WHERE id = $1', [job.game_id, cents]);
      if (inserted.rows[0]) {
        await emit(tx, job.game_id, `player:${job.player_id}`, 'message', {
          suspectId: p.suspectId,
          message: toMessageDto(message),
        });
      }
      return { status: 'done', duplicate: false, messageId: String(message.id) };
    });
  }

  /** The agent could not produce a result. Retry until attempts run out. */
  async fail(jobId: string, leaseToken: string, error: string): Promise<{ status: 'pending' | 'failed' }> {
    return withTx(this.db, async (tx) => {
      const { rows } = await tx.query<JobRow>('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
      const job = rows[0];
      if (!job) throw new HttpError(404, 'job_not_found');
      if (job.status !== 'running' || job.lease_token !== leaseToken)
        throw new HttpError(409, 'lease_lost', 'This job is no longer leased to you.');
      return this.releaseOrFail(tx, job, error);
    });
  }

  private async releaseOrFail(tx: Tx, job: JobRow, error: string) {
    if (job.attempts < this.opts.maxAttempts) {
      await tx.query(
        `UPDATE jobs SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
                error = $2, updated_at = now()
          WHERE id = $1`,
        [job.id, error],
      );
      return { status: 'pending' as const };
    }
    await tx.query(
      `UPDATE jobs SET status = 'failed', lease_token = NULL, error = $2, updated_at = now() WHERE id = $1`,
      [job.id, error],
    );
    await lockGame(tx, job.game_id);
    const { rows } = await tx.query<MessageRow>(
      `INSERT INTO messages (interview_id, role, text, job_id)
       VALUES ($1, 'system', 'No answer came. Try asking again.', $2)
       ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [job.payload.interviewId, job.id],
    );
    if (rows[0])
      await emit(tx, job.game_id, `player:${job.player_id}`, 'message', {
        suspectId: job.payload.suspectId,
        message: toMessageDto(rows[0]),
      });
    return { status: 'failed' as const };
  }

  /** Return expired leases to the queue, or fail jobs that have used all their attempts. */
  async requeueExpired(): Promise<number> {
    return withTx(this.db, async (tx) => {
      const { rows } = await tx.query<JobRow>(
        `SELECT * FROM jobs WHERE status = 'running' AND lease_expires_at < now()
          ORDER BY id FOR UPDATE SKIP LOCKED`,
      );
      for (const job of rows) await this.releaseOrFail(tx, job, 'lease expired');
      return rows.length;
    });
  }
}
