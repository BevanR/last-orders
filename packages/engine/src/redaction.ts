import type { CaseFile } from './schema.js';
import {
  accusationOpen,
  availableActions,
  unlockedActions,
  unlockedLocations,
  type AvailableActions,
} from './rules.js';
import { nextHint } from './context.js';
import { buildReveal, type Reveal } from './reveal.js';
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

export type NoticeKind = 'hint' | 'event' | 'highlight_location' | 'notice' | 'suggest_advance';

/** A game-master intervention as players see it. */
export interface Notice {
  id: string;
  kind: NoticeKind;
  text: string;
  at: number;
}

export interface GameView {
  title: string;
  intro: string;
  layout: string;
  status: GameStatus;
  act: { number: number; name: string; intro: string };
  actsTotal: number;
  players: PlayerRef[];
  /** Present for player and host audiences. */
  me?: PlayerRef;
  locations: {
    id: string;
    name: string;
    description: string;
    /** This viewer has performed an action here. */
    visited: boolean;
    /** The game master pointed the group here and nobody has been since. */
    highlighted: boolean;
    actions: { id: string; label: string; done: boolean }[];
  }[];
  suspects: { id: string; name: string; role: string; description: string }[];
  /** Evidence this viewer found, shared or not. Empty for the public audience. */
  notebook: (EvidenceCard & { shared: boolean })[];
  board: (EvidenceCard & { sharedBy: string })[];
  actions: AvailableActions;
  /** Game-master notices given so far, oldest first. Suggestions to advance are for the host only. */
  notices: Notice[];
  accusation: {
    open: boolean;
    minAct: number;
    maxEvidence: number;
    /** The group's accusation once submitted. Never carries a verdict before the reveal. */
    submitted: {
      by: string;
      suspectId: string;
      suspectName: string;
      evidence: EvidenceCard[];
      reasoning: string;
    } | null;
  };
  host?: {
    canStart: boolean;
    canAdvance: boolean;
    nextAct: string | null;
    canEnd: boolean;
    canHint: boolean;
  };
  /** Only after the host has ended the investigation. */
  reveal?: Reveal;
}

function card(c: CaseFile, id: string): EvidenceCard | null {
  const e = c.evidence.find((x) => x.id === id);
  return e ? { id: e.id, name: e.name, description: e.description } : null;
}

function noticeKind(id: string): NoticeKind | null {
  const prefix = id.split(':')[0];
  switch (prefix) {
    case 'hint':
    case 'event':
    case 'highlight_location':
    case 'notice':
    case 'suggest_advance':
      return prefix;
    default:
      return null;
  }
}

/**
 * The view of a game an audience may see. Never includes testimony states, transition triggers,
 * persona or hidden facts, locked locations or actions, other players' unshared evidence, the
 * verdict, or the solution before the game ends.
 */
export function redact(c: CaseFile, s: GameState, audience: Audience): GameView {
  const viewerId = audience.kind === 'public' ? null : audience.playerId;
  const act = c.acts[s.act - 1] ?? c.acts[0]!;
  const nameOf = (playerId: string) => s.players.find((p) => p.id === playerId)?.name ?? 'Someone';
  const shared = new Set(s.board.map((b) => b.evidenceId));
  const highlightedAt = (locationId: string) =>
    s.interventions.find((i) => i.id === `highlight_location:${locationId}`)?.at;
  const view: GameView = {
    title: c.title,
    intro: c.intro,
    layout: c.layout,
    status: s.status,
    act: { number: act.number, name: act.name, intro: act.intro },
    actsTotal: c.acts.length,
    players: s.players.map((p) => ({ ...p })),
    locations:
      s.status === 'lobby'
        ? []
        : unlockedLocations(c, s).map((l) => {
            const h = highlightedAt(l.id);
            return {
              id: l.id,
              name: l.name,
              description: l.description,
              visited: viewerId !== null && s.visits.some((v) => v.locationId === l.id && v.playerId === viewerId),
              highlighted: h !== undefined && !s.visits.some((v) => v.locationId === l.id),
              actions: unlockedActions(l, s).map((a) => ({
                id: a.id,
                label: a.label,
                done:
                  viewerId !== null &&
                  s.visits.some((v) => v.locationId === l.id && v.actionId === a.id && v.playerId === viewerId),
              })),
            };
          }),
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
      viewerId === null
        ? { inspect: [], interview: [], share: [], present: [], accuse: false }
        : availableActions(c, s, viewerId),
    notices: s.interventions.flatMap((i) => {
      const kind = noticeKind(i.id);
      if (!kind || (kind === 'suggest_advance' && audience.kind !== 'host')) return [];
      return [{ id: i.id, kind, text: i.text, at: i.at }];
    }),
    accusation: {
      open: accusationOpen(c, s),
      minAct: c.accusation.min_act,
      maxEvidence: c.accusation.max_evidence,
      submitted: s.accusation
        ? {
            by: nameOf(s.accusation.playerId),
            suspectId: s.accusation.suspectId,
            suspectName: c.suspects.find((x) => x.id === s.accusation!.suspectId)?.name ?? '',
            evidence: s.accusation.evidenceIds.flatMap((id) => {
              const k = card(c, id);
              return k ? [k] : [];
            }),
            reasoning: s.accusation.reasoning,
          }
        : null,
    },
  };
  if (viewerId !== null) view.me = s.players.find((p) => p.id === viewerId);
  if (audience.kind === 'host') {
    const next = s.status === 'active' ? c.acts[s.act] : undefined;
    view.host = {
      canStart: s.status === 'lobby',
      canAdvance: next !== undefined,
      nextAct: next ? next.name : null,
      canEnd: s.status === 'active',
      canHint: s.status === 'active' && s.accusation === null && nextHint(c, s) !== null,
    };
  }
  if (s.status === 'ended') view.reveal = buildReveal(c, s);
  return view;
}
