import type { SuspectContext, TokenUsage } from '@last-orders/engine';
import type { SuspectPrompt } from '../prompt.js';

export interface ModelReply {
  text: string;
  usage: TokenUsage | null;
  simulated: boolean;
}

export interface ModelAdapter {
  readonly name: string;
  reply(prompt: SuspectPrompt, ctx: SuspectContext): Promise<ModelReply>;
}
