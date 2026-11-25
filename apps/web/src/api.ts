import type { GameView, Notice, Reveal } from '@last-orders/engine';

export type { GameView, Notice, Reveal };

/** The state endpoint's response: the redacted view, the SSE cursor and, after the end, commentary. */
export type View = GameView & {
  cursor: number;
  commentary?: { text: string; simulated: boolean } | null;
};

export interface Message {
  id: string;
  role: 'player' | 'suspect' | 'system';
  text: string;
  presentedEvidenceId: string | null;
  simulated: boolean;
  createdAt: string;
}

export interface Interview {
  suspectId: string;
  messages: Message[];
  waiting: boolean;
}

export interface InspectResult {
  locationId: string;
  actionId: string;
  text: string;
  found: { id: string; name: string; description: string; text: string }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Something went wrong.');
  return data as T;
}

const room = (code: string) => `/api/rooms/${encodeURIComponent(code)}`;
const enc = encodeURIComponent;

export const api = {
  createRoom: (displayName: string) =>
    call<{ roomCode: string; hostUrl: string; inviteUrl: string }>('POST', '/api/rooms', { displayName }),
  join: (code: string, displayName: string) =>
    call<{ roomCode: string }>('POST', `${room(code)}/join`, { displayName }),
  claimHost: (hostToken: string) => call<{ roomCode: string }>('POST', '/api/host/claim', { hostToken }),
  state: (code: string) => call<View>('GET', `${room(code)}/state`),
  start: (code: string) => call<{ ok: true }>('POST', `${room(code)}/start`),
  advance: (code: string) => call<{ ok: true }>('POST', `${room(code)}/advance`),
  end: (code: string) => call<{ ok: true }>('POST', `${room(code)}/end`),
  hint: (code: string) => call<{ text: string }>('POST', `${room(code)}/hint`),
  accuse: (code: string, suspectId: string, evidenceIds: string[], reasoning: string) =>
    call<{ ok: true }>('POST', `${room(code)}/accuse`, { suspectId, evidenceIds, reasoning }),
  inspect: (code: string, locationId: string, actionId: string) =>
    call<InspectResult>('POST', `${room(code)}/inspect`, { locationId, actionId }),
  share: (code: string, evidenceId: string) =>
    call<{ alreadyOnBoard: boolean }>('POST', `${room(code)}/share`, { evidenceId }),
  interview: (code: string, suspectId: string) => call<Interview>('GET', `${room(code)}/interviews/${enc(suspectId)}`),
  say: (code: string, suspectId: string, text: string) =>
    call<{ message: Message }>('POST', `${room(code)}/interviews/${enc(suspectId)}/messages`, { text }),
  present: (code: string, suspectId: string, evidenceId: string) =>
    call<{ message: Message }>('POST', `${room(code)}/interviews/${enc(suspectId)}/present`, { evidenceId }),
  eventsUrl: (code: string) => `${room(code)}/events`,
};

/** Per-browser conveniences. Storage can be missing or blocked; failures are ignored. */
export const local = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // ignore
    }
  },
};
