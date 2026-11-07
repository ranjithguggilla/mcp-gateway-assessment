/**
 * Streaming PII redactor with a bounded hold-back buffer.
 *
 * The problem: a secret can be split across chunks ("jane.doe@exa" | "mple.com").
 * Running a regex per chunk misses it; buffering the whole response is O(n) memory.
 *
 * The approach: keep a small `tail`. On every push, emit only the prefix that is
 * provably safe — everything up to the last *safe boundary* — and hold the rest.
 *
 * A safe boundary is a whitespace character that is not preceded by a digit.
 *   - none of the patterns (email, SSN) contain whitespace, so a match can never
 *     straddle a whitespace boundary ...
 *   - ... except card numbers, which allow single spaces between digit groups
 *     ("4111 1111 1111 1111"). Requiring the char before the whitespace to be a
 *     non-digit means we never cut inside a spaced digit group.
 *
 * Memory bound: the tail is at most one whitespace-free run (plus trailing digit
 * groups). A pathological run with no whitespace is force-cut at MAX_HOLD so the
 * buffer is bounded by a constant, not by response length. MAX_HOLD defaults to
 * 254 = the RFC 5321 maximum email length and the longest pattern we match.
 *
 * Overflow policy (fail closed): a force-cut slice could in theory split a
 * secret. If the slice contains anything that could be part of one ("@" or a
 * run of 13+ digits/separators) the whole slice is replaced with [REDACTED]
 * rather than released. Natural language never hits this path; base64 blobs
 * and URLs with embedded emails do, and are suppressed rather than leaked.
 *
 * TTFT: the first word is released on the first whitespace, not after 254 chars.
 */

export const DEFAULT_MAX_HOLD = 254;

// email | ssn | card (13-19 digits with optional single space/dash separators)
const PII_RE = /([A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,189}\.[A-Z]{2,})|(\b\d{3}-\d{2}-\d{4}\b)|(\b(?:\d[ -]?){12,18}\d\b)/gi;

export const REDACTED = "[REDACTED]";

/** Luhn checksum — rejects things like order numbers that merely look like cards. */
export function luhn(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Strict SSN: reject area 000, 666, 9xx; group 00; serial 0000. */
function validSsn(ssn: string): boolean {
  const [area, group, serial] = ssn.split("-");
  if (!area || !group || !serial) return false;
  if (area === "000" || area === "666" || area.startsWith("9")) return false;
  if (group === "00" || serial === "0000") return false;
  return true;
}

export interface RedactStats {
  emails: number;
  ssns: number;
  cards: number;
  cardsSkippedLuhn: number;
  /** Force-cut slices suppressed because they might hold a split secret (overflow policy). */
  overflowSuppressed: number;
}

export function redactText(text: string, stats?: RedactStats): string {
  return text.replace(PII_RE, (m: string, email?: string, ssn?: string, card?: string) => {
    if (email) {
      if (stats) stats.emails++;
      return REDACTED;
    }
    if (ssn) {
      if (!validSsn(ssn)) return m;
      if (stats) stats.ssns++;
      return REDACTED;
    }
    if (card) {
      if (!luhn(card)) {
        if (stats) stats.cardsSkippedLuhn++;
        return m;
      }
      if (stats) stats.cards++;
      return REDACTED;
    }
    return m;
  });
}

function isWs(c: string): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r";
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

export class Redactor {
  private tail = "";
  readonly maxHold: number;
  readonly stats: RedactStats = { emails: 0, ssns: 0, cards: 0, cardsSkippedLuhn: 0, overflowSuppressed: 0 };
  /** Largest tail ever held — exposed so tests can assert the bound. */
  peakHold = 0;

  constructor(maxHold: number = DEFAULT_MAX_HOLD) {
    this.maxHold = maxHold;
  }

  /** Feed a chunk; returns the text that is safe to emit now (possibly ""). */
  push(chunk: string): string {
    if (!chunk) return "";
    this.tail += chunk;

    // Find the last safe boundary: whitespace not preceded by a digit.
    let cut = -1;
    for (let i = this.tail.length - 1; i > 0; i--) {
      if (isWs(this.tail[i]!) && !isDigit(this.tail[i - 1]!)) {
        cut = i + 1; // emit through the whitespace itself
        break;
      }
    }

    // Force a cut if the held run exceeds the bound (no pattern is longer than maxHold).
    let forced = false;
    if (cut === -1 || this.tail.length - cut > this.maxHold) {
      if (this.tail.length <= this.maxHold) {
        this.peakHold = Math.max(this.peakHold, this.tail.length);
        return "";
      }
      forced = true;
      cut = this.tail.length - this.maxHold;
    }

    const safe = this.tail.slice(0, cut);
    this.tail = this.tail.slice(cut);
    this.peakHold = Math.max(this.peakHold, this.tail.length);

    if (forced) {
      // The slice ends mid-token. Release only the part up to the last safe boundary
      // inside it; fail closed on the remainder if it could be a secret fragment.
      let inner = -1;
      for (let i = safe.length - 1; i > 0; i--) {
        if (isWs(safe[i]!) && !isDigit(safe[i - 1]!)) {
          inner = i + 1;
          break;
        }
      }
      const head = inner === -1 ? "" : safe.slice(0, inner);
      const frag = inner === -1 ? safe : safe.slice(inner);
      const suspicious = frag.includes("@") || /(?:\d[ -]?){13,}/.test(frag) || /\d[ -]?$/.test(frag) || /^[ -]?\d/.test(this.tail);
      this.stats.overflowSuppressed += suspicious ? 1 : 0;
      return redactText(head, this.stats) + (suspicious ? REDACTED : redactText(frag, this.stats));
    }
    return redactText(safe, this.stats);
  }

  /** Provider stream ended: redact and release whatever is held. */
  flush(): string {
    const out = redactText(this.tail, this.stats);
    this.tail = "";
    return out;
  }

  get held(): number {
    return this.tail.length;
  }
}
