import { describe, expect, test } from "bun:test"
import { PII } from "@opencode-ai/core/session/pii"

describe("PII.detect", () => {
  test("finds email addresses", () => {
    const report = PII.detect("contact user.vova+test@example.com or admin@site.org for details")
    expect(report.types).toContain("email")
    expect(report.counts.email).toBe(2)
  })

  test("finds credit card with Luhn validation", () => {
    const report = PII.detect("card 4111 1111 1111 1111 charged")
    expect(report.types).toContain("credit_card")
    expect(report.counts.credit_card).toBe(1)
  })

  test("rejects invalid card numbers that fail Luhn", () => {
    const report = PII.detect("card 4111 1111 1111 1112 charged")
    expect(report.counts.credit_card).toBe(0)
  })

  test("finds international phone numbers", () => {
    const report = PII.detect("call +7 916 123 45 67 or +1 (555) 123-4567")
    expect(report.counts.phone).toBeGreaterThanOrEqual(1)
  })

  test("does not count a credit card as a phone", () => {
    const report = PII.detect("card 4111 1111 1111 1111")
    expect(report.counts.phone).toBe(0)
    expect(report.counts.credit_card).toBe(1)
  })

  test("finds API keys", () => {
    const report = PII.detect('sk-proj-abcdef1234567890ABCDEF and ghp_abcdefghijklmnopqrstuv123456')
    expect(report.counts.api_key).toBe(2)
  })

  test("finds assignment-style secrets", () => {
    const report = PII.detect('process.env.API_KEY = "dGhpc0lzTG9uZ1NlY3JldFZhbHVlMTIzNDU2"')
    expect(report.types).toContain("api_key")
  })

  test("clean text reports nothing", () => {
    const report = PII.detect("run npm test and check packages/core/src/session/index.ts")
    expect(report.types).toEqual([])
    expect(PII.tag("run npm test")).toBeUndefined()
  })

  test("tag renders sorted unique categories", () => {
    const tag = PII.tag("mail a@b.com card 4111 1111 1111 1111 key sk-abcdefghijklmnopqrstuvwxyz012345")
    expect(tag).toBe("pii=email,credit_card,api_key")
  })
})

describe("PII.redact", () => {
  test("redacts bare API keys", () => {
    const result = PII.redact("use sk-proj-abcdef1234567890ABCDEF or ghp_abcdefghijklmnopqrstuv123456 now")
    expect(result.text).not.toContain("sk-proj-abcdef")
    expect(result.text).not.toContain("ghp_abc")
    expect(result.text).toContain("[REDACTED:api_key]")
    expect(result.redacted).toContain("api_key")
  })

  test("keeps parameter name when redacting assignment-style secrets", () => {
    const result = PII.redact('process.env.API_KEY = "dGhpc0lzTG9uZ1NlY3JldFZhbHVlMTIzNDU2"')
    expect(result.text).not.toContain("dGhpc0lzTG9uZ1NlY3JldFZhbHVlMTIzNDU2")
    expect(result.text).toContain("API_KEY")
    expect(result.text).toContain("[REDACTED:api_key]")
  })

  test("redacts secret URL query params but keeps other params", () => {
    const result = PII.redact("https://api.example.com/v1/data?access_token=abcdef1234567890&limit=5")
    expect(result.text).not.toContain("abcdef1234567890")
    expect(result.text).toContain("access_token=[REDACTED:url_secret]")
    expect(result.text).toContain("limit=5")
    expect(result.redacted).toContain("url_secret")
  })

  test("redacts Bearer tokens", () => {
    const result = PII.redact('curl -H "Authorization: Bearer dGhpc0lzTG9uZ1NlY3JldFZhbHVlMTIz" https://x.test')
    expect(result.text).not.toContain("dGhpc0lzTG9uZ1NlY3JldFZhbHVlMTIz")
    expect(result.text).toContain("Bearer [REDACTED:bearer]")
    expect(result.redacted).toContain("bearer")
  })

  test("redacts Luhn-valid credit cards", () => {
    const result = PII.redact("charged card 4111 1111 1111 1111 today")
    expect(result.text).not.toContain("4111")
    expect(result.text).toContain("[REDACTED:credit_card]")
    expect(result.redacted).toContain("credit_card")
  })

  test("does not redact invalid card-like digit runs", () => {
    const result = PII.redact("build id 4111 1111 1111 1112 finished")
    expect(result.text).toBe("build id 4111 1111 1111 1112 finished")
    expect(result.redacted).toEqual([])
  })

  test("keeps emails and phones (tag-only policy)", () => {
    const result = PII.redact("mail vova@example.com or call +7 916 123 45 67")
    expect(result.text).toBe("mail vova@example.com or call +7 916 123 45 67")
    expect(result.redacted).toEqual([])
  })

  test("leaves clean text unchanged", () => {
    const result = PII.redact("run npm test and check packages/core/src/session/pii.ts")
    expect(result.text).toBe("run npm test and check packages/core/src/session/pii.ts")
    expect(result.redacted).toEqual([])
  })
})
