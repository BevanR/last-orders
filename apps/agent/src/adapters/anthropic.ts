import Anthropic from '@anthropic-ai/sdk';
import type { SuspectContext } from '@last-orders/engine';
import type { SuspectPrompt } from '../prompt.js';
import type { ModelAdapter, ModelReply } from './types.js';

export interface AnthropicAdapterOptions {
  model: string;
  /** The Sprites gateway URL in production. Unset: the SDK default. */
  baseURL?: string;
  /**
   * Set for direct API use. Unset (behind the Sprites gateway): no auth header is sent, because
   * the gateway identifies the Sprite and adds the key itself.
   */
  apiKey?: string;
  maxTokens?: number;
  /** Test hook: replaces the SDK's HTTP transport. */
  fetch?: typeof fetch;
}

/** Suspect replies from Claude through the official SDK. */
export class AnthropicAdapter implements ModelAdapter {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicAdapterOptions) {
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 400;
    this.client = new Anthropic({
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.apiKey
        ? { apiKey: opts.apiKey }
        : { apiKey: 'unused-behind-gateway', defaultHeaders: { 'x-api-key': null, authorization: null } }),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      maxRetries: 2,
      timeout: 30_000,
    });
  }

  async reply(prompt: SuspectPrompt, ctx: SuspectContext): Promise<ModelReply> {
    // No sampling parameters and no thinking setting: thinking stays adaptive, kept short by
    // low effort. Suspect replies are short, so max_tokens stays small.
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: prompt.system,
      messages: prompt.messages,
      output_config: { effort: 'low' },
    });
    const usage = {
      model: this.model,
      inputTokens:
        res.usage.input_tokens +
        (res.usage.cache_creation_input_tokens ?? 0) +
        (res.usage.cache_read_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
    };
    if (res.stop_reason === 'refusal') {
      return { text: `${ctx.suspect.name} looks away and says nothing.`, usage, simulated: false };
    }
    const text = res.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim();
    if (!text) throw new Error(`empty reply (stop_reason ${res.stop_reason})`);
    return { text, usage, simulated: false };
  }
}
