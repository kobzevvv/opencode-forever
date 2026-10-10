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
