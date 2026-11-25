import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'lo_session';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A short, unambiguous room code for invite links. */
export function newRoomCode(length = 6): string {
  const bytes = randomBytes(length);
  return [...bytes].map((b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
}

export interface Session {
  playerId: string;
  displayName: string;
  isHost: boolean;
  gameId: string;
  roomCode: string;
}

/** Resolve the session cookie to a player in the given room. Throws 401/403 otherwise. */
export async function requireMember(db: Db, req: FastifyRequest, roomCode: string): Promise<Session> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw new HttpError(401, 'not_signed_in', 'Join the room first.');
  const { rows } = await db.query<{
    player_id: string;
    display_name: string;
    is_host: boolean;
    game_id: string;
    room_code: string;
  }>(
    `SELECT p.id AS player_id, p.display_name, p.is_host, g.id AS game_id, g.room_code
       FROM players p JOIN games g ON g.id = p.game_id
      WHERE p.session_token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) throw new HttpError(401, 'not_signed_in', 'Join the room first.');
  if (row.room_code !== roomCode.toUpperCase()) throw new HttpError(403, 'not_a_member', 'You are not in this room.');
  return {
    playerId: row.player_id,
    displayName: row.display_name,
    isHost: row.is_host,
    gameId: row.game_id,
    roomCode: row.room_code,
  };
}

export function requireHost(s: Session) {
  if (!s.isHost) throw new HttpError(403, 'host_only', 'Only the host can do that.');
}

/** Constant-time bearer check for the internal agent API. */
export function checkBearer(header: string | undefined, secret: string): boolean {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}
