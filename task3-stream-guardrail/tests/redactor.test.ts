import { describe, expect, it } from "vitest";
import { Redactor, luhn, redactText, REDACTED } from "../src/redactor.js";
import { SseParser, extractDelta } from "../src/sse.js";

/** Feed `text` through a fresh Redactor split at the given boundaries and return the full output. */
function stream(parts: string[], maxHold?: number): { out: string; r: Redactor } {
  const r = new Redactor(maxHold);
  let out = "";
  for (const p of parts) out += r.push(p);
  out += r.flush();
  return { out, r };
}

const EMAIL = "jane.doe@example.com";
const SSN = "123-45-6789";
const CARD = "4111 1111 1111 1111";

describe("redactText (single chunk)", () => {
  it("redacts email, ssn and card", () => {
    expect(redactText(`mail ${EMAIL}, ssn ${SSN}, card ${CARD}.`)).toBe(`mail ${REDACTED}, ssn ${REDACTED}, card ${REDACTED}.`);
  });
  it("redacts dashed and bare card numbers that pass Luhn", () => {
    expect(redactText("5500-0000-0000-0004")).toBe(REDACTED);
    expect(redactText("4111111111111111")).toBe(REDACTED);
    expect(redactText("378282246310005")).toBe(REDACTED); // 15-digit Amex
  });
  it("leaves non-Luhn digit runs alone (order numbers)", () => {
    expect(luhn("1234 5678 9012 3456")).toBe(false);
    expect(redactText("order 1234 5678 9012 3456 shipped")).toBe("order 1234 5678 9012 3456 shipped");
  });
  it("leaves invalid SSN area/group/serial alone", () => {
    expect(redactText("000-12-3456 666-12-3456 900-12-3456 123-00-4567 123-45-0000")).toBe("000-12-3456 666-12-3456 900-12-3456 123-00-4567 123-45-0000");
  });
  it("does not treat phone numbers as cards or SSNs", () => {
    expect(redactText("call 555-123-4567 or 212 555 0199")).toBe("call 555-123-4567 or 212 555 0199");
  });
});

describe("Redactor across chunk boundaries", () => {
  const sentence = `Please contact ${EMAIL} today.`;

  it("whole secret in one chunk", () => {
    expect(stream([sentence]).out).toBe(`Please contact ${REDACTED} today.`);
  });

  it("email split at EVERY character index", () => {
    for (let i = 1; i < sentence.length; i++) {
      const { out } = stream([sentence.slice(0, i), sentence.slice(i)]);
      expect(out, `split at ${i}: ${JSON.stringify([sentence.slice(0, i), sentence.slice(i)])}`).toBe(`Please contact ${REDACTED} today.`);
    }
  });

  it("email split into three and into single characters", () => {
    expect(stream(["Please contact jane.d", "oe@exa", "mple.com today."]).out).toBe(`Please contact ${REDACTED} today.`);
    expect(stream([...sentence]).out).toBe(`Please contact ${REDACTED} today.`);
  });

  it("SSN split after the first dash and at every index", () => {
    const s = `SSN: ${SSN} ok`;
    expect(stream(["SSN: 123-", "45-6789 ok"]).out).toBe(`SSN: ${REDACTED} ok`);
    for (let i = 1; i < s.length; i++) expect(stream([s.slice(0, i), s.slice(i)]).out).toBe(`SSN: ${REDACTED} ok`);
  });

  it("card with spaces split mid-group and at every index", () => {
    const s = `card ${CARD} end`;
    expect(stream(["card 4111 11", "11 1111 1111 end"]).out).toBe(`card ${REDACTED} end`);
    expect(stream(["card 4111 1111 ", "1111 1111 end"]).out).toBe(`card ${REDACTED} end`);
    for (let i = 1; i < s.length; i++) expect(stream([s.slice(0, i), s.slice(i)]).out).toBe(`card ${REDACTED} end`);
  });

  it("non-Luhn 16 digits split across chunks are left alone", () => {
    expect(stream(["order 1234 5678 ", "9012 3456 shipped"]).out).toBe("order 1234 5678 9012 3456 shipped");
  });

  it("text without PII passes through byte-identical, whatever the chunking", () => {
    const text = "The quick brown fox jumps over the lazy dog.\nNumbers like 42 and 2024-01-01 stay.\tTabs too.";
    for (const n of [1, 2, 3, 7, 13, 100]) {
      const parts: string[] = [];
      for (let i = 0; i < text.length; i += n) parts.push(text.slice(i, i + n));
      expect(stream(parts).out).toBe(text);
    }
  });

  it("secret at the very end of the stream is caught by flush()", () => {
    expect(stream(["my email is ", "jane@exa", "mple.com"]).out).toBe(`my email is ${REDACTED}`);
  });

  it("releases the first word early (TTFT): output before the hold-back fills", () => {
    const r = new Redactor();
    expect(r.push("Hello ")).toBe("Hello "); // whitespace boundary -> emitted immediately
    expect(r.push("world")).toBe(""); // held: could be the start of an email
    expect(r.push(" again")).toBe("world ");
    expect(r.flush()).toBe("again");
  });

  it("memory stays bounded by the hold-back, not by stream length", () => {
    // 1 MB of prose with no PII, pushed in 1 KB chunks: tail never exceeds maxHold.
    const word = "lorem ipsum dolor sit amet ";
    const r = new Redactor(254);
    let total = 0;
    for (let i = 0; i < 1024; i++) {
      const chunk = word.repeat(40).slice(0, 1024);
      total += r.push(chunk).length;
      expect(r.held).toBeLessThanOrEqual(254);
    }
    total += r.flush().length;
    expect(total).toBe(1024 * 1024);
    expect(r.peakHold).toBeLessThanOrEqual(254);
  });

  it("overflow: a whitespace-free run longer than maxHold is force-cut (bounded); harmless runs pass, suspicious ones fail closed", () => {
    const r = new Redactor(64);
    const run = "x".repeat(500);
    let out = r.push(run);
    expect(r.held).toBeLessThanOrEqual(64);
    out += r.push(` ${EMAIL} `) + r.flush();
    expect(out).toBe(`${run} ${REDACTED} `); // plain letters: released unchanged
    expect(r.stats.overflowSuppressed).toBe(0);

    // An email buried inside a 300-char whitespace-free blob: the force-cut slice contains "@" -> suppressed, never leaked.
    const blob = "A".repeat(150) + EMAIL + "B".repeat(150);
    const r2 = new Redactor(64);
    let out2 = "";
    for (let i = 0; i < blob.length; i += 7) out2 += r2.push(blob.slice(i, i + 7));
    out2 += r2.flush();
    expect(out2).not.toContain("jane");
    expect(out2).not.toContain("example.com");
    expect(r2.stats.overflowSuppressed).toBeGreaterThan(0);
    expect(r2.peakHold).toBeLessThanOrEqual(64);

    // A card number straddling the forced cut: digits at the cut edge -> suppressed.
    const blob2 = "Z".repeat(100) + "4111111111111111" + "Z".repeat(100);
    const r3 = new Redactor(64);
    let out3 = "";
    for (let i = 0; i < blob2.length; i += 5) out3 += r3.push(blob2.slice(i, i + 5));
    out3 += r3.flush();
    expect(out3).not.toMatch(/4111\d{12}/);
  });

  it("counts what it redacted", () => {
    const { r } = stream([`${EMAIL} ${SSN} ${CARD} 1234 5678 9012 3456`]);
    expect(r.stats).toEqual({ emails: 1, ssns: 1, cards: 1, cardsSkippedLuhn: 1, overflowSuppressed: 0 });
  });
});

describe("SseParser", () => {
  it("reassembles events split across reads", () => {
    const p = new SseParser();
    expect(p.push('data: {"a":')).toEqual([]);
    expect(p.push('1}\n\ndata: {"b":2}\n')).toEqual(['{"a":1}']);
    expect(p.push("\n")).toEqual(['{"b":2}']);
    expect(p.pending).toBe(0);
  });
  it("handles CRLF and multi-line data", () => {
    const p = new SseParser();
    expect(p.push("event: x\r\ndata: one\r\ndata: two\r\n\r\n")).toEqual(["one\ntwo"]);
  });
  it("flush returns an unterminated trailing event", () => {
    const p = new SseParser();
    p.push("data: tail");
    expect(p.flush()).toEqual(["tail"]);
  });
});

describe("extractDelta", () => {
  it("reads OpenAI, Anthropic and simple shapes", () => {
    expect(extractDelta(JSON.stringify({ choices: [{ delta: { content: "hi" } }] }))).toEqual({ text: "hi", done: false });
    expect(extractDelta(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "yo" } }))).toEqual({ text: "yo", done: false });
    expect(extractDelta(JSON.stringify({ type: "message_stop" }))).toEqual({ text: "", done: true });
    expect(extractDelta(JSON.stringify({ delta: "x" }))).toEqual({ text: "x", done: false });
    expect(extractDelta("[DONE]")).toEqual({ text: "", done: true });
    expect(extractDelta("not json")).toEqual({ text: "", done: false });
  });
});
