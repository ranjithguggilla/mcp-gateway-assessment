// Found by the audit fuzzer: a card followed by another number was swallowed as one over-long digit span,
// failed Luhn, and went out in clear (and took an adjacent SSN with it).
import { describe, expect, it } from "vitest";
import { Redactor, redactText, REDACTED } from "../src/redactor.js";

describe("card next to other numbers", () => {
  it.each([
    ["card 4111111111111111 123", `card ${REDACTED} 123`],
    ["4111 1111 1111 1111 123", `${REDACTED} 123`],
    ["4111111111111111 123-45-6789", `${REDACTED} ${REDACTED}`],
    ["666-12-3456 4111 1111 1111 1111", `666-12-3456 ${REDACTED}`],
    ["3782 822463 10005 123", `${REDACTED} 123`],
    ["order 42 4111111111111111 42", `order 42 ${REDACTED} 42`],
  ])("%j", (input, expected) => expect(redactText(input)).toBe(expected));

  it.each([
    "000-12-3456 666-12-3456 900-12-3456 123-00-4567 123-45-0000",
    "order 1234 5678 9012 3456 shipped",
    "abc4111111111111111",
    "4111111111111111abc",
    "ref 1234567890 1234567890",
  ])("does not over-redact %j", (input) => expect(redactText(input)).toBe(input));
});

// Deterministic generator so a failure is reproducible from the seed.
function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const SECRETS = ["jane.doe@example.com", "a@b.io", "123-45-6789", "078-05-1120", "4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "3782 822463 10005", "5500005555555559"];
const FILL = ["hello", "order", "is", "42", "12345", "ok.", "café", "😀", "\n", "$19.99", "3.2.1"];

function pushAll(chunks: string[]) {
  const r = new Redactor();
  let out = "";
  for (const c of chunks) out += r.push(c);
  return out + r.flush();
}

describe("streaming equals one-shot, at every split point and for random chunkings", () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}`, () => {
      const rnd = lcg(seed);
      for (let d = 0; d < 40; d++) {
        let text = "";
        const secrets: string[] = [];
        for (let i = 0, n = 6 + Math.floor(rnd() * 20); i < n; i++) {
          const secret = rnd() < 0.35;
          const piece = secret ? SECRETS[Math.floor(rnd() * SECRETS.length)]! : FILL[Math.floor(rnd() * FILL.length)]!;
          if (secret) secrets.push(piece);
          text += piece + (rnd() < 0.2 ? "\n" : " ");
        }
        const expected = redactText(text);
        for (const s of secrets) expect(expected).not.toContain(s);
        for (let i = 1; i < text.length; i++) expect(pushAll([text.slice(0, i), text.slice(i)])).toBe(expected);
        for (const k of [1, 2, 3]) expect(pushAll(text.match(new RegExp(`[\\s\\S]{1,${k}}`, "g"))!)).toBe(expected);
        const rc: string[] = [];
        for (let i = 0; i < text.length; ) { const k = 1 + Math.floor(rnd() * 12); rc.push(text.slice(i, i + k)); i += k; }
        expect(pushAll(rc)).toBe(expected);
      }
    });
  }
});
