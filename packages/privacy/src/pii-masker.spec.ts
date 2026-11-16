import { describe, expect, it, vi } from "vitest";
import {
  createPiiMasker,
  describePiiCounts,
  ibanValid,
  luhnValid,
  maskStringLeaves,
  emptyPiiCounts,
  parsePiiPatternList,
  totalPiiCount,
} from "./pii-masker";
import { resolvePiiMasking } from "./option";

const masker = createPiiMasker();
const mask = (text: string) => masker.mask(text).text;

describe("createPiiMasker — what it masks", () => {
  it("masks email addresses, including Slack's mailto links", () => {
    expect(mask("Reported by alice@example.com.")).toBe("Reported by [email].");
    expect(mask("cc first.last+tag@mail.acme.test")).toBe("cc [email]");
    expect(mask("<mailto:alice@example.com|alice@example.com>")).toBe("<mailto:[email]|[email]>");
    expect(mask("bot 12345+acme-bot@users.noreply.github.com")).toBe("bot [email]");
  });

  it("masks international and common local phone numbers", () => {
    expect(mask("call +44 20 7946 0958 now")).toBe("call [phone] now");
    expect(mask("call +1 (202) 555-0143")).toBe("call [phone]");
    expect(mask("call +12025550143")).toBe("call [phone]");
    expect(mask("call 202-555-0143")).toBe("call [phone]");
    expect(mask("call (202) 555-0143")).toBe("call [phone]");
    expect(mask("call 202.555.0143")).toBe("call [phone]");
    expect(mask("call 020 7946 0958")).toBe("call [phone]");
    expect(mask("call (020) 7946 0958")).toBe("call [phone]");
    expect(mask("mobile 07700 900123")).toBe("mobile [phone]");
    expect(mask("tel: 01 23 45 67 89")).toBe("tel: [phone]");
    expect(mask("on 2026-11-12 202-555-0143 called")).toBe("on 2026-11-12 [phone] called");
  });

  it("masks Luhn-valid card numbers written together, spaced or dashed", () => {
    expect(mask("card 4111 1111 1111 1111 exp 12/30")).toBe("card [card] exp 12/30");
    expect(mask("card 4111-1111-1111-1111")).toBe("card [card]");
    expect(mask("card 4111111111111111")).toBe("card [card]");
    expect(mask("amex 3782 822463 10005")).toBe("amex [card]");
    expect(mask("mc 5555555555554444")).toBe("mc [card]");
    // A rejected candidate overlapping the card must not hide it.
    expect(mask("ref 7946 0958 4111 1111 1111 1111")).toBe("ref 7946 0958 [card]");
  });

  it("masks checksum-valid IBANs, spaced or compact", () => {
    expect(mask("IBAN GB82 WEST 1234 5698 7654 32 please")).toBe("IBAN [iban] please");
    expect(mask("IBAN GB82WEST12345698765432")).toBe("IBAN [iban]");
    expect(mask("pay GB82 WEST 1234 5698 7654 32 OK")).toBe("pay [iban] OK");
  });

  it("masks IPv4 and IPv6 addresses", () => {
    expect(mask("from 203.0.113.7 at login")).toBe("from [ip] at login");
    expect(mask("client 192.0.2.10:443 refused")).toBe("client [ip]:443 refused");
    expect(mask("from 2001:db8::8a2e:370:7334 today")).toBe("from [ip] today");
    expect(mask("from 2001:0db8:0000:0000:0000:ff00:0042:8329")).toBe("from [ip]");
    expect(mask("[2001:db8::1]:8080")).toBe("[[ip]]:8080");
  });

  it("counts each kind, and counts only", () => {
    const result = masker.mask("alice@example.com, bob@example.com, +44 20 7946 0958, 4111 1111 1111 1111");
    expect(result.counts).toMatchObject({ email: 2, phone: 1, card: 1, iban: 0, ip: 0, custom: 0 });
    expect(totalPiiCount(result.counts)).toBe(4);
    expect(describePiiCounts(result.counts)).toBe("email=2 phone=1 card=1");
  });
});

describe("createPiiMasker — what it leaves alone", () => {
  const untouched = [
    "commit 3f2a9c1b7d4e5f60718293a4b5c6d7e8f9012345",
    "short sha a1b2c3d",
    "upgrade to 1.2.3 then 10.20.30",
    "build 10.0.19045.3803",
    "at 2026-11-12T10:01:02Z and 2026-11-12 10:01:02.123",
    "on 12/11/2026 and 2026-11-12",
    "fixes #1234 and acme/repo#5678",
    "open http://localhost:3000 and localhost:3000",
    "see https://github.com/acme/repo/pull/1234/files#diff-0123456789",
    "path /var/log/2026-11-12/app.log and src/a/b.ts:120",
    "hey <@U0TEST01> in <#C0TEST01|general> or C0TEST01",
    "slack ts 1700000000.123456 and run 12345678901",
    "ms timestamp 1731400000000 and id 9876543210123",
    "loopback 127.0.0.1 and 0.0.0.0 and ::1",
    "remote git@github.com:acme/repo.git",
    "install @acme/pkg@1.2.3 and react@18.2.0",
    "asset icon@2x.png",
    "Rust std::vec::Vec and Foo::Bar, dead::beef",
    "time 10:30:45 and mac aa:bb:cc:dd:ee:ff",
    "p50 120 340 560 780 ms",
    "lines 120-130 and 200-210",
    "github login @alice-acme reported it",
    "not a card 4111 1111 1111 1112",
    "not an iban GB82 WEST 1234 5698 7654 33",
    "version 999.999.999.999",
    "port 192.0.2 is not an address",
  ];

  for (const text of untouched) {
    it(`leaves "${text}"`, () => {
      const result = masker.mask(text);
      expect(result.text).toBe(text);
      expect(totalPiiCount(result.counts)).toBe(0);
    });
  }

  it("does not mask numbers inside URLs", () => {
    const url = "https://example.com/u/202-555-0143/ip/203.0.113.7";
    expect(mask(`open ${url} now`)).toBe(`open ${url} now`);
  });
});

describe("createPiiMasker — idempotence and extra patterns", () => {
  it("masking twice gives the same text as masking once", () => {
    const text =
      "alice@example.com +44 20 7946 0958 4111 1111 1111 1111 GB82 WEST 1234 5698 7654 32 203.0.113.7 2001:db8::1 EMP-12345";
    const extra = createPiiMasker({ extraPatterns: ["EMP-\\d{5}"] });
    const once = extra.mask(text);
    const twice = extra.mask(once.text);
    expect(once.text).toBe("[email] [phone] [card] [iban] [ip] [ip] [redacted]");
    expect(twice.text).toBe(once.text);
    expect(totalPiiCount(twice.counts)).toBe(0);
  });

  it("applies the deployment's extra patterns, with /body/flags syntax", () => {
    const extra = createPiiMasker({ extraPatterns: ["EMP-\\d{5}", "/customer id: \\w+/i", /ACCT\d+/] });
    expect(extra.extraPatternCount).toBe(3);
    const result = extra.mask("EMP-12345 and Customer ID: x9 and ACCT42");
    expect(result.text).toBe("[redacted] and [redacted] and [redacted]");
    expect(result.counts.custom).toBe(3);
  });

  it("ignores a bad extra pattern and reports it", () => {
    const onInvalidPattern = vi.fn();
    const extra = createPiiMasker({ extraPatterns: ["(unclosed", "x*", "EMP-\\d+"], onInvalidPattern });
    expect(extra.extraPatternCount).toBe(1);
    expect(onInvalidPattern).toHaveBeenCalledTimes(2);
    expect(onInvalidPattern.mock.calls[1]).toEqual(["x*", "matches the empty string"]);
    expect(extra.mask("EMP-7 alice@example.com").text).toBe("[redacted] [email]");
  });

  it("splits an environment value on newlines and ||", () => {
    expect(parsePiiPatternList("EMP-\\d+||CUST-\\w+\n  ACCT\\d+  \n")).toEqual(["EMP-\\d+", "CUST-\\w+", "ACCT\\d+"]);
    expect(parsePiiPatternList("")).toEqual([]);
    expect(parsePiiPatternList(undefined)).toEqual([]);
  });
});

describe("checksums", () => {
  it("validates Luhn", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("41x1")).toBe(false);
  });

  it("validates IBAN length and mod-97", () => {
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB82WEST12345698765433")).toBe(false);
    expect(ibanValid("GB82WEST1234569876543")).toBe(false);
    expect(ibanValid("ZZ82WEST12345698765432")).toBe(false);
  });
});

describe("maskStringLeaves", () => {
  it("masks string values and leaves keys and other types alone", () => {
    const counts = emptyPiiCounts();
    const input = { "alice@example.com": "alice@example.com", n: 4111111111111111, list: ["+44 20 7946 0958", true] };
    expect(maskStringLeaves(input, masker, counts)).toEqual({
      "alice@example.com": "[email]",
      n: 4111111111111111,
      list: ["[phone]", true],
    });
    expect(counts).toMatchObject({ email: 1, phone: 1 });
    expect(input["alice@example.com"]).toBe("alice@example.com");
  });
});

describe("resolvePiiMasking", () => {
  it("is on by default and off only when asked", () => {
    expect(resolvePiiMasking(undefined)?.masker.mask("alice@example.com").text).toBe("[email]");
    expect(resolvePiiMasking({})).toBeDefined();
    expect(resolvePiiMasking(false)).toBeUndefined();
  });
});
