import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseCase, type CaseFile } from '@last-orders/engine';
import type { Db } from './db.js';

/** Loads case versions from the database and keeps parsed copies in memory. */
export class CaseStore {
  private cache = new Map<number, CaseFile>();
  currentVersionId = 0;

  constructor(private readonly db: Db) {}

  /** Validate the case file and make it the version new games use. */
  async loadCurrent(path: string): Promise<CaseFile> {
    const text = await readFile(path, 'utf8');
    const parsed = parseCase(JSON.parse(text));
    const body = JSON.stringify(parsed);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO case_versions (case_id, sha256, body) VALUES ($1, $2, $3)
       ON CONFLICT (sha256) DO UPDATE SET case_id = EXCLUDED.case_id
       RETURNING id`,
      [parsed.id, sha256, body],
    );
    this.currentVersionId = rows[0]!.id;
    this.cache.set(this.currentVersionId, parsed);
    return parsed;
  }

  async get(versionId: number): Promise<CaseFile> {
    const hit = this.cache.get(versionId);
    if (hit) return hit;
    const { rows } = await this.db.query<{ body: unknown }>('SELECT body FROM case_versions WHERE id = $1', [
      versionId,
    ]);
    if (!rows[0]) throw new Error(`case version ${versionId} not found`);
    const parsed = parseCase(rows[0].body);
    this.cache.set(versionId, parsed);
    return parsed;
  }
}
