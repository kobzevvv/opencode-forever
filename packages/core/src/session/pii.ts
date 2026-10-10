export * as PII from "./pii"

export type PIICategory = "email" | "phone" | "credit_card" | "api_key"

export type Report = {
  readonly types: readonly PIICategory[]
  readonly counts: Readonly<Record<PIICategory, number>>
}

const EMAIL = /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.-])/g
const CARD = /(?<!\w)(?:\d[ -]?){12,18}\d(?!\w)/g
const INTERNATIONAL_PHONE = /\+\d[\d ()-]{6,20}\d/g
const SEPARATED_RUN = /(?<!\w)(?:\d[ .-]?){9,14}\d(?!\w)/g
const API_KEY_BARE: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
]
// Capture group keeps the parameter name visible when the value is redacted.
const API_KEY_ASSIGNMENT =
  /(?<![\w-])((?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|password)["']?\s*[:=]\s*)["']?[A-Za-z0-9_./+-]{16,}(?![\w-])/gi
const API_KEY_PATTERNS: readonly RegExp[] = [...API_KEY_BARE, API_KEY_ASSIGNMENT]
const URL_SECRET_PARAM = /([?&](?:access[_-]?token|api[_-]?key|auth|credential|key|password|secret|sig|signature|token)=)[^&\s"'<>]+/gi
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi

const CATEGORIES: readonly PIICategory[] = ["email", "phone", "credit_card", "api_key"]

const emptyCounts = (): Record<PIICategory, number> => ({
  email: 0,
  phone: 0,
  credit_card: 0,
  api_key: 0,
})

const luhn = (value: string) => {
  let sum = 0
  let alternate = false
  for (let i = value.length - 1; i >= 0; i--) {
    const code = value.charCodeAt(i) - 48
    if (code < 0 || code > 9) return false
    let digit = code
    if (alternate) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    alternate = !alternate
  }
  return value.length > 0 && sum % 10 === 0
}

const digitsOf = (value: string) => value.replace(/\D/g, "")

type Span = { readonly start: number; readonly end: number }

const overlaps = (span: Span, taken: readonly Span[]) =>
  taken.some((other) => span.start < other.end && other.start < span.end)

const countMatches = (regex: RegExp, text: string, visit: (match: RegExpExecArray) => void) => {
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    visit(match)
    if (match.index === regex.lastIndex) regex.lastIndex++
  }
}

export const detect = (text: string): Report => {
  const counts = emptyCounts()
  const cardSpans: Span[] = []

  countMatches(CARD, text, (match) => {
    const digits = digitsOf(match[0])
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      counts.credit_card++
      cardSpans.push({ start: match.index, end: match.index + match[0].length })
    }
  })

  countMatches(EMAIL, text, () => {
    counts.email++
  })

  const phoneSpans: Span[] = []
  const markPhone = (span: Span) => {
    if (overlaps(span, cardSpans) || overlaps(span, phoneSpans)) return false
    phoneSpans.push(span)
    counts.phone++
    return true
  }

  countMatches(INTERNATIONAL_PHONE, text, (match) => {
    markPhone({ start: match.index, end: match.index + match[0].length })
  })

  countMatches(SEPARATED_RUN, text, (match) => {
    const span = { start: match.index, end: match.index + match[0].length }
    if (overlaps(span, cardSpans) || overlaps(span, phoneSpans)) return
    const raw = match[0]
    const digits = digitsOf(raw)
    if (digits.length < 10 || digits.length > 15) return
    const hasSeparator = /[ .-]/.test(raw)
    if (!hasSeparator && digits.length > 11) return
    markPhone(span)
  })

  for (const pattern of API_KEY_PATTERNS) {
    countMatches(pattern, text, () => {
      counts.api_key++
    })
  }

  const types = CATEGORIES.filter((type) => counts[type] > 0)
  return { types, counts }
}

export const tag = (text: string): string | undefined => {
  const report = detect(text)
  return report.types.length === 0 ? undefined : `pii=${report.types.join(",")}`
}

export type Redaction = {
  readonly text: string
  readonly redacted: readonly string[]
}

// Replaces credential-bearing content with self-describing placeholders before
// text is placed into compact markers, search previews or telemetry. Emails and
// phone numbers are intentionally kept (tag-only): they are not credentials and
// the pii= tag already flags them. Full originals stay in SQLite and remain
// retrievable via get_tool_call_details.
export const redact = (text: string): Redaction => {
  const found = new Set<string>()
  let out = text
  out = out.replace(URL_SECRET_PARAM, (_match, prefix: string) => {
    found.add("url_secret")
    return `${prefix}[REDACTED:url_secret]`
  })
  out = out.replace(BEARER_TOKEN, (_match, prefix: string) => {
    found.add("bearer")
    return `${prefix}[REDACTED:bearer]`
  })
  for (const pattern of API_KEY_BARE) {
    out = out.replace(pattern, () => {
      found.add("api_key")
      return "[REDACTED:api_key]"
    })
  }
  out = out.replace(API_KEY_ASSIGNMENT, (_match, prefix: string) => {
    found.add("api_key")
    return `${prefix}[REDACTED:api_key]`
  })
  const cards: Span[] = []
  countMatches(CARD, out, (match) => {
    const digits = digitsOf(match[0])
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits))
      cards.push({ start: match.index, end: match.index + match[0].length })
  })
  for (let index = cards.length - 1; index >= 0; index--) {
    const span = cards[index]
    out = out.slice(0, span.start) + "[REDACTED:credit_card]" + out.slice(span.end)
  }
  if (cards.length > 0) found.add("credit_card")
  return { text: out, redacted: [...found] }
}
