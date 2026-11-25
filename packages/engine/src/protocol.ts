import type { CommentaryContext, GmContext, SuspectContext } from './context.js';

/** Wire types for the internal agent API, shared by the app and the agent. */

interface JobBase {
  id: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attempt: number;
  /** When true the agent must use the simulated adapter (the game is over its spend cap). */
  simulatedOnly: boolean;
}

export type ClaimedJob =
  | (JobBase & { kind: 'suspect_reply'; context: SuspectContext })
  | (JobBase & { kind: 'gm_tick'; context: GmContext })
  | (JobBase & { kind: 'reveal_commentary'; context: CommentaryContext });

export type JobKind = ClaimedJob['kind'];

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** A suspect reply or commentary is text; a game-master tick is a choice from the allowed list. */
export type JobOutput = { text: string } | { choice_id: string; reason: string };

export interface CompleteJobRequest {
  leaseToken: string;
  output: JobOutput;
  simulated: boolean;
  usage: TokenUsage | null;
}

export type CompleteJobResponse =
  | { status: 'done'; duplicate: boolean; messageId: string | null }
  | { status: 'requeued'; reason: 'stale' };

export interface FailJobRequest {
  leaseToken: string;
  error: string;
}
