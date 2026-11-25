import type { CaseFile, Solution } from './schema.js';
import { availableActions, unlockedLocations, type AvailableActions } from './rules.js';
import type { GameState, GameStatus, PlayerRef } from './state.js';

/** Who a view or event is for. Matches `game_events.audience` in the server. */
export type Audience = { kind: 'public' } | { kind: 'player'; playerId: string } | { kind: 'host'; playerId: string };

export function audienceKey(a: Audience): string {
  return a.kind === 'public' ? 'public' : a.kind === 'host' ? 'host' : `player:${a.playerId}`;
}

/** The audience keys a viewer may read, for filtering stored events. */
export function readableAudienceKeys(viewer: { playerId: string; isHost: boolean }): string[] {
  const keys = ['public', `player:${viewer.playerId}`];
  if (viewer.isHost) keys.push('host');
  return keys;
}

export interface EvidenceCard {
  id: string;
  name: string;
  description: string;
}

export interface GameView {
  title: string;
  intro: string;
  status: GameStatus;
  act: { number: number; name: string; intro: string };
  actsTotal: number;
  players: PlayerRef[];
  /** Present for player and host audiences. */
  me?: PlayerRef;
  locations: { id: string; name: string; description: string; visited: boolean }[];
  suspects: { id: string; name: string; role: string; description: string }[];
  /** Evidence this viewer found, shared or not. Empty for the public audience. */
  notebook: (EvidenceCard & { shared: boolean })[];
  board: (EvidenceCard & { sharedBy: string })[];
  actions: AvailableActions;
  host?: { canStart: boolean; canAdvance: boolean; nextAct: string | null };
  /** Only after the game has ended. */
  solution?: Solution;
}

function card(c: CaseFile, id: string): EvidenceCard | null {
  const e = c.evidence.find((x) => x.id === id);
  return e ? { id: e.id, name: e.name, description: e.description } : null;
}

/**
 * The view of a game an audience may see. Never includes testimony states, transition triggers,
 * persona or hidden facts, locked locations, other players' unshared evidence, or the solution
 * before the game ends.
 */
export function redact(c: CaseFile, s: GameState, audience: Audience): GameView {
  const viewerId = audience.kind === 'public' ? null : audience.playerId;
  const act = c.acts[s.act - 1] ?? c.acts[0]!;
  const nameOf = (playerId: string) => s.players.find((p) => p.id === playerId)?.name ?? 'Someone';
  const shared = new Set(s.board.map((b) => b.evidenceId));
  const view: GameView = {
    title: c.title,
    intro: c.intro,
    status: s.status,
    act: { number: act.number, name: act.name, intro: act.intro },
    actsTotal: c.acts.length,
    players: s.players.map((p) => ({ ...p })),
    locations:
      s.status === 'lobby'
        ? []
        : unlockedLocations(c, s).map((l) => ({
            id: l.id,
            name: l.name,
            description: l.description,
            visited: viewerId !== null && s.visits.some((v) => v.locationId === l.id && v.playerId === viewerId),
          })),
    suspects: c.suspects.map((x) => ({
      id: x.id,
      name: x.name,
      role: x.role,
      description: x.public_description,
    })),
    notebook:
      viewerId === null
        ? []
        : s.discoveries
            .filter((d) => d.playerId === viewerId)
            .flatMap((d) => {
              const k = card(c, d.evidenceId);
              return k ? [{ ...k, shared: shared.has(d.evidenceId) }] : [];
            }),
    board: s.board.flatMap((b) => {
      const k = card(c, b.evidenceId);
      return k ? [{ ...k, sharedBy: nameOf(b.sharedBy) }] : [];
    }),
    actions:
      viewerId === null ? { inspect: [], interview: [], share: [], present: [] } : availableActions(c, s, viewerId),
  };
  if (viewerId !== null) view.me = s.players.find((p) => p.id === viewerId);
  if (audience.kind === 'host') {
    const next = s.status === 'active' ? c.acts[s.act] : undefined;
    view.host = {
      canStart: s.status === 'lobby',
      canAdvance: next !== undefined,
      nextAct: next ? next.name : null,
    };
  }
  if (s.status === 'ended') view.solution = c.solution;
  return view;
}
