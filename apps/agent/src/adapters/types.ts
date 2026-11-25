import type { CommentaryContext, GmContext, SuspectContext, TokenUsage } from '@last-orders/engine';
import type { SuspectPrompt, TextPrompt } from '../prompt.js';

export interface ModelReply {
  text: string;
  usage: TokenUsage | null;
  simulated: boolean;
}

export interface GmChoice {
  choice_id: string;
  reason: string;
  usage: TokenUsage | null;
  simulated: boolean;
}

export interface ModelAdapter {
  readonly name: string;
  /** A suspect's spoken reply. */
  reply(prompt: SuspectPrompt, ctx: SuspectContext): Promise<ModelReply>;
  /** The game master's choice. Must be one of `ctx.interventions`. */
  chooseIntervention(prompt: TextPrompt, ctx: GmContext): Promise<GmChoice>;
  /** Commentary on the reveal. */
  commentary(prompt: TextPrompt, ctx: CommentaryContext): Promise<ModelReply>;
}
