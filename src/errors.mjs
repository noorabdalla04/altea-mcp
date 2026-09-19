// Typed, actionable errors. Every failure the tools surface carries a stable code, whether a retry is safe,
// and the next valid action, so an agent can recover without guessing.
export const CODES = {
  NOT_SIGNED_IN: { retryable: false, next: 'Ask the member to run `altea login` (node bin/altea.mjs login in the repo: a one-time Chrome sign-in), then retry.' },
  BAD_INPUT: { retryable: false, next: 'Fix the argument and call again.' },
  NOT_FOUND: { retryable: false, next: 'Get a current id from altea_schedule / altea_find / altea_next and retry.' },
  WINDOW_NOT_OPEN: { retryable: false, next: 'Tell the member when booking opens (48 h before start); offer to book then.' },
  LATE_CANCEL: { retryable: false, next: 'Tell the member the fee and deadline; call again with force=true only if they confirm.' },
  EVENT_FULL: { retryable: false, next: 'Offer altea_waitlist join, or altea_next for the next occurrence with spots.' },
  CONFLICT: { retryable: false, next: 'Show the conflicting booking; ask whether to cancel it or book anyway (force=true).' },
  UNSIGNED_AGREEMENT: { retryable: false, next: 'The member must sign the waiver in the Altea app first; never sign on their behalf.' },
  NO_MEMBERSHIP: { retryable: false, next: 'This event is not covered by the membership; say so.' },
  PAID_OPTION: { retryable: false, next: 'Only paid options are offered; tell the member the price and book only if they explicitly ask, passing perkId.' },
  UNKNOWN_ACTION: { retryable: true, next: 'Call altea_actions with refresh=true once, then retry.' },
  UPSTREAM: { retryable: true, next: 'Transient upstream problem; retry once after a few seconds.' },
  TIMEOUT: { retryable: true, next: 'The call exceeded its time budget; retry once, or narrow the request (fewer days/groups).' },
};

export class AlteaError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AlteaError';
    this.code = CODES[code] ? code : 'UPSTREAM';
    this.retryable = extra.retryable ?? CODES[this.code].retryable;
    this.next = extra.next ?? CODES[this.code].next;
    this.details = extra.details;
  }
  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable, next: this.next, ...(this.details ? { details: this.details } : {}) }; }
}

/** Wrap any thrown value into an AlteaError (NotSignedIn from session.mjs is mapped by name). */
export function toAlteaError(e) {
  if (e instanceof AlteaError) return e;
  if (e?.name === 'NotSignedIn') return new AlteaError('NOT_SIGNED_IN', e.message);
  if (e?.name === 'TimeoutError' || /timed? ?out/i.test(String(e?.message))) return new AlteaError('TIMEOUT', e.message);
  return new AlteaError('UPSTREAM', e?.message || String(e));
}

/** Promise with a time budget. */
export function withTimeout(promise, ms, label = 'operation') {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new AlteaError('TIMEOUT', `${label} exceeded ${ms} ms`)), ms); });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

/** Simple async mutex: mutations run one at a time (one Chrome window, one profile). */
export class Mutex {
  #chain = Promise.resolve();
  run(fn) { const p = this.#chain.then(fn, fn); this.#chain = p.catch(() => {}); return p; }
}
