import Anthropic from '@anthropic-ai/sdk';
import type { CommentaryContext, GmContext, SuspectContext, TokenUsage } from '@last-orders/engine';
import type { SuspectPrompt, TextPrompt } from '../prompt.js';
import type { GmChoice, ModelAdapter, ModelReply } from './types.js';

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

/** Suspect replies, game-master choices and reveal commentary from Claude through the official SDK. */
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

  private usageOf(res: Anthropic.Message): TokenUsage {
    return {
      model: this.model,
      inputTokens:
        res.usage.input_tokens +
        (res.usage.cache_creation_input_tokens ?? 0) +
        (res.usage.cache_read_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
    };
  }

  private static text(res: Anthropic.Message): string {
    return res.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim();
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
    const usage = this.usageOf(res);
    if (res.stop_reason === 'refusal') {
      return { text: `${ctx.suspect.name} looks away and says nothing.`, usage, simulated: false };
    }
    const text = AnthropicAdapter.text(res);
    if (!text) throw new Error(`empty reply (stop_reason ${res.stop_reason})`);
    return { text, usage, simulated: false };
  }

  /**
   * The game master's choice, as structured output constrained to the allowed ids. The app
   * checks the id again before applying anything.
   */
  async chooseIntervention(prompt: TextPrompt, ctx: GmContext): Promise<GmChoice> {
    const ids = ctx.interventions.map((i) => i.id);
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              choice_id: { type: 'string', enum: ids },
              reason: { type: 'string' },
            },
            required: ['choice_id', 'reason'],
            additionalProperties: false,
          },
        },
      },
    });
    const usage = this.usageOf(res);
    if (res.stop_reason === 'refusal') return { choice_id: 'none', reason: 'refused', usage, simulated: false };
    let parsed: { choice_id?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(AnthropicAdapter.text(res)) as typeof parsed;
    } catch {
      throw new Error(`game master returned invalid JSON (stop_reason ${res.stop_reason})`);
    }
    if (typeof parsed.choice_id !== 'string' || !ids.includes(parsed.choice_id))
      throw new Error(`game master chose an id that is not allowed: ${String(parsed.choice_id).slice(0, 80)}`);
    return {
      choice_id: parsed.choice_id,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : '',
      usage,
      simulated: false,
    };
  }

  async commentary(prompt: TextPrompt, _ctx: CommentaryContext): Promise<ModelReply> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      output_config: { effort: 'low' },
    });
    const usage = this.usageOf(res);
    const text = res.stop_reason === 'refusal' ? '' : AnthropicAdapter.text(res);
    if (!text) throw new Error(`empty commentary (stop_reason ${res.stop_reason})`);
    return { text, usage, simulated: false };
  }
}
