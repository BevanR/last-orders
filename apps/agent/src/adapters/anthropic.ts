import Anthropic from '@anthropic-ai/sdk';
import { type Dispatcher, fetch as undiciFetch } from 'undici';
import { createShortKeepAliveDispatcher } from '../http.js';
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
  /** Test hook: replaces the HTTP transport (undici's fetch). It receives `init.dispatcher`. */
  fetch?: typeof fetch;
  /**
   * Per-attempt time limit in ms, covering the response body as well as the headers (default
   * 30 s). The SDK's own timeout stops at the headers, so a body that stalls would otherwise hang
   * the job until its lease expires.
   */
  timeoutMs?: number;
  /** Creates the connection pool for model calls (default: short keep-alive undici Agent). */
  createDispatcher?: () => Dispatcher;
  log?: (msg: string) => void;
}

/** Suspect replies, game-master choices and reveal commentary from Claude through the official SDK. */
export class AnthropicAdapter implements ModelAdapter {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly createDispatcher: () => Dispatcher;
  private readonly log: (msg: string) => void;
  private dispatcher: Dispatcher;

  constructor(opts: AnthropicAdapterOptions) {
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 400;
    this.createDispatcher = opts.createDispatcher ?? createShortKeepAliveDispatcher;
    this.log = opts.log ?? (() => {});
    this.dispatcher = this.createDispatcher();
    // undici's own fetch, so the dispatcher comes from the same undici version as the fetch.
    const baseFetch = opts.fetch ?? (undiciFetch as unknown as typeof fetch);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    this.client = new Anthropic({
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.apiKey
        ? { apiKey: opts.apiKey }
        : { apiKey: 'unused-behind-gateway', defaultHeaders: { 'x-api-key': null, authorization: null } }),
      // Every request goes through the current pool; reset after a network failure.
      fetch: (url, init) => {
        const deadline = AbortSignal.timeout(timeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
        return baseFetch(url, { ...init, signal, dispatcher: this.dispatcher } as unknown as RequestInit);
      },
      // No SDK retries: they would also retry HTTP 408/409/429/5xx (and anything the server
      // marks x-should-retry), and a model call must never be paid for twice. create() does
      // the single network-error retry itself.
      maxRetries: 0,
      timeout: timeoutMs,
    });
  }

  /**
   * messages.create with one retry, on a fresh connection pool, when the request failed at the
   * network level or timed out: APIConnectionError (which includes APIConnectionTimeoutError),
   * or the per-attempt deadline cutting off a response body. HTTP error responses (any status)
   * are never retried.
   */
  private async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create(params);
    } catch (err) {
      if (!AnthropicAdapter.isNetworkFailure(err)) throw err;
      this.log(`model request failed (${(err as Error).message}); retrying on a fresh connection`);
      const old = this.dispatcher;
      this.dispatcher = this.createDispatcher();
      old.destroy().catch(() => {});
      return await this.client.messages.create(params);
    }
  }

  private static isNetworkFailure(err: unknown): boolean {
    if (err instanceof Anthropic.APIConnectionError) return true;
    if (err instanceof Anthropic.APIError) return false;
    const name = (err as Error | undefined)?.name;
    return name === 'TimeoutError' || name === 'AbortError';
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
    const res = await this.create({
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
    const res = await this.create({
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
    const res = await this.create({
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
