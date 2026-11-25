import type { Intervention } from '@last-orders/engine';
import type { Tx } from './db.js';
import { emit } from './events.js';

/**
 * Record and announce one authored game-master intervention. Runs under the game row lock.
 * Each intervention is applied at most once per game; returns false if it already was.
 * A suggestion to advance goes to the host only; everything else is public.
 */
export async function applyIntervention(
  tx: Tx,
  gameId: string,
  iv: Intervention,
  source: 'gm' | 'host',
): Promise<boolean> {
  if (iv.kind === 'none') return false;
  const ins = await tx.query(
    `INSERT INTO game_interventions (game_id, intervention_id, text, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (game_id, intervention_id) DO NOTHING`,
    [gameId, iv.recordId, iv.text, source],
  );
  if (ins.rowCount !== 1) return false;
  const audience = iv.kind === 'suggest_advance' ? 'host' : 'public';
  await emit(tx, gameId, audience, 'gm_notice', { id: iv.recordId, kind: iv.kind, text: iv.text });
  return true;
}
