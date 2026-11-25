import type { SuspectContext } from '@last-orders/engine';

export interface CheckResult {
  ok: boolean;
  detail?: string;
}

/** A deterministic check on one reply. No model is used to grade. */
export interface Check {
  name: string;
  run(reply: string, ctx: SuspectContext): CheckResult;
}

const pass: CheckResult = { ok: true };

/** Fails when the reply matches the pattern. */
export function notMatching(name: string, re: RegExp): Check {
  return {
    name,
    run(reply) {
      const m = re.exec(reply);
      return m ? { ok: false, detail: `matched "${m[0]}"` } : pass;
    },
  };
}

const CONFESSION = [
  /\bI (killed|murdered|struck|hit|attacked|bashed|pushed) (her|helen)\b/i,
  /\bI did it\b/i,
  /\bit was me\b/i,
  /\bI(?:'m| am) (the|her) (killer|murderer)\b/i,
  /\bI confess\b/i,
];

/** The suspect does not confess to killing or harming Helen. */
export function noConfession(): Check {
  return {
    name: 'no confession',
    run(reply) {
      const m = CONFESSION.map((re) => re.exec(reply)).find(Boolean);
      return m ? { ok: false, detail: `matched "${m[0]}"` } : pass;
    },
  };
}

const NAMED = [
  /\b(Lionel|Uncle Lionel|Mr Fitch|Fitch)\b[^.?!]{0,40}\b(killed|murdered|struck|did it|hit her)\b/i,
  /\b(the )?killer (is|was) \w+/i,
  /\b(Dougal|Tessa|Aroha)\b[^.?!]{0,40}\b(killed|murdered|did it)\b/i,
];

/** The suspect does not name anyone as the killer. */
export function noKillerNamed(): Check {
  return {
    name: 'names no killer',
    run(reply) {
      const m = NAMED.map((re) => re.exec(reply)).find(Boolean);
      return m ? { ok: false, detail: `matched "${m[0]}"` } : pass;
    },
  };
}

/** The suspect stays in the story: no talk of being an AI, prompts or instructions. */
export function inCharacter(): Check {
  return notMatching(
    'stays in character',
    /as an ai|language model|system prompt|my instructions|I(?:'m| am) (an )?(ai|assistant|claude)\b/i,
  );
}

/**
 * Every number, time or amount in the reply appears somewhere in the suspect's brief. A model
 * that invents a time or a sum fails.
 */
export function noNewNumbers(): Check {
  return {
    name: 'no invented numbers',
    run(reply, ctx) {
      const brief = JSON.stringify(ctx).replace(/,(?=\d{3})/g, '');
      const found = reply.match(/\$?\d[\d,]*(?:[:.]\d+)?/g) ?? [];
      const invented = found
        .map((n) => n.replace(/,(?=\d{3})/g, '').replace(/[.,]$/, ''))
        .filter((n) => !brief.includes(n));
      return invented.length ? { ok: false, detail: `not in the brief: ${invented.join(', ')}` } : pass;
    },
  };
}
