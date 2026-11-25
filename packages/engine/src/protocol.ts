import type { SuspectContext } from './context.js';

/** Wire types for the internal agent API, shared by the app and the agent. */

export interface ClaimedJob {
  id: string;
  kind: 'suspect_reply';
  leaseToken: string;
  leaseExpiresAt: string;
  attempt: number;
  /** When true the agent must use the simulated adapter (the game is over its spend cap). */
  simulatedOnly: boolean;
  context: SuspectContext;
}

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CompleteJobRequest {
  leaseToken: string;
  output: { text: string };
  simulated: boolean;
  usage: TokenUsage | null;
}

export type CompleteJobResponse =
  | { status: 'done'; duplicate: boolean; messageId: string }
  | { status: 'requeued'; reason: 'stale' };

export interface FailJobRequest {
  leaseToken: string;
  error: string;
}
