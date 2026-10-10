import { Effect, Schema } from "effect"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable } from "@opencode-ai/core/session/sql"
import type { SessionID } from "../session/schema"
import * as Tool from "./tool"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const PREVIEW_CHARS = 240
const INPUT_SUMMARY_CHARS = 200

export const Parameters = Schema.Struct({
  tool: Schema.optional(Schema.String.annotate({ description: "Exact tool name to filter by (e.g. bash, read)" })),
  status: Schema.optional(
    Schema.Literals(["pending", "running", "completed", "error"]).annotate({
      description: "Filter by tool call status",
    }),
  ),
  query: Schema.optional(
    Schema.String.annotate({
      description:
        "Regular expression matched against tool input (command/url/path), output text and error message, case-insensitive",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: `Maximum results to return, most recent first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
    }),
  ),
})

type Metadata = { matched: number }

const bound = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max))

const inputSummary = (input: unknown) => {
  if (typeof input === "string") return input === "" ? undefined : bound(input, INPUT_SUMMARY_CHARS)
  if (input === null || typeof input !== "object") return undefined
  const entries = Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => {
      if (typeof value === "string") return `${key}=${value}`
      if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`
      return undefined
    })
    .filter((line): line is string => line !== undefined)
  return entries.length === 0 ? undefined : bound(entries.join(" "), INPUT_SUMMARY_CHARS)
}

export type Candidate = {
  call_id: string
  tool: string
  status: string
  input?: string
  preview?: string
  error?: string
  haystack: string
  seq: string
}

const candidate = (data: unknown, id: string): Candidate | undefined => {
  if (typeof data !== "object" || data === null) return undefined
  const part = data as {
    type?: string
    callID?: string
    tool?: string
    state?: { status?: string; input?: unknown; output?: string; error?: string }
  }
  if (part.type !== "tool" || typeof part.callID !== "string") return undefined
  const state = part.state
  const input = inputSummary(state?.input)
  const output = typeof state?.output === "string" ? state.output : undefined
  const error = typeof state?.error === "string" ? state.error : undefined
  const preview = output === undefined && error === undefined ? undefined : bound([output, error].filter(Boolean).join("\n"), PREVIEW_CHARS)
  return {
    call_id: part.callID,
    tool: part.tool ?? "unknown",
    status: state?.status ?? "pending",
    ...(input === undefined ? {} : { input }),
    ...(preview === undefined ? {} : { preview }),
    ...(error === undefined ? {} : { error: bound(error, PREVIEW_CHARS) }),
    haystack: [input, preview].filter((piece): piece is string => piece !== undefined).join("\n"),
    seq: id,
  }
}

export const collectCandidates = (db: Database.Interface["db"], sessionID: SessionID) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({ id: PartTable.id, data: PartTable.data })
      .from(PartTable)
      .where(and(eq(PartTable.session_id, sessionID), sql`json_extract(${PartTable.data}, '$.type') = 'tool'`))
      .orderBy(PartTable.time_created)
      .all()
      .pipe(Effect.orDie)
    return rows.flatMap((row) => {
      const item = candidate(row.data, row.id)
      return item === undefined ? [] : [item]
    })
  })

export const FindToolCallsTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "find_tool_calls",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    return {
      description:
        "Search tool calls in this session by tool name, status or pattern. " +
        "Returns compact entries (call_id, status, input, preview) so you can locate a call and then load its full " +
        "output with get_tool_call_details(call_id). Compacted [mem:compacted] results are searchable here because " +
        "the originals live in session history.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "find_tool_calls",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const regex = params.query === undefined ? undefined : new RegExp(params.query, "i")
          const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
          const matched = (yield* collectCandidates(db, ctx.sessionID)).filter((item) => {
            if (params.tool !== undefined && item.tool !== params.tool) return false
            if (params.status !== undefined && item.status !== params.status) return false
            if (regex !== undefined && !regex.test(item.haystack)) return false
            return true
          })
          const calls = matched
            .slice(-limit)
            .reverse()
            .map(({ haystack: _haystack, seq: _seq, ...item }) => item)
          return {
            title: `${matched.length} matching tool calls`,
            output: JSON.stringify({ calls, matched: matched.length }, null, 2),
            metadata: { matched: matched.length },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
