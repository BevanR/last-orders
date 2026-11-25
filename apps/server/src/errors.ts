import { RuleError, type RuleErrorCode } from '@last-orders/engine';
import type { ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const RULE_STATUS: Record<RuleErrorCode, number> = {
  game_not_active: 409,
  game_not_in_lobby: 409,
  unknown_location: 404,
  location_locked: 403,
  unknown_evidence: 404,
  evidence_not_held: 403,
  unknown_suspect: 404,
  no_next_act: 409,
  unknown_action: 404,
  action_locked: 403,
  accusation_not_open: 409,
  accusation_submitted: 409,
  invalid_accusation: 400,
  no_hint: 409,
};

/** Convert an engine rule error to an HTTP error; pass anything else through. */
export function toHttpError(err: unknown): unknown {
  if (err instanceof RuleError) return new HttpError(RULE_STATUS[err.code], err.code, err.message);
  return err;
}

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new HttpError(400, 'invalid_request', first ? `${first.path.join('.')}: ${first.message}` : 'invalid');
  }
  return result.data;
}
