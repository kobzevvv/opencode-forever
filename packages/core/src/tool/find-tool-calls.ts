export * as FindToolCallsTool from "./find-tool-calls"

import { and, asc, eq } from "drizzle-orm"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionMessageTable } from "../session/sql"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "find_tool_calls"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const PREVIEW_CHARS = 240
const INPUT_SUMMARY_CHARS = 200

export const Input = Schema.Struct({
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
    Schema.Number.annotate({ description: `Maximum results to return, most recent first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` }),
  ),
})

export const Call = Schema.Struct({
  call_id: Schema.String,
  tool: Schema.String,
  status: Schema.String,
  message_id: Schema.String,
  seq: Schema.Number,
  input: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

export const Output = Schema.Struct({
  calls: Schema.Array(Call),
  matched: Schema.Number,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output, null, 2)

const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

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

const contentText = (content: readonly SessionMessage.ToolStateCompleted["content"][number][]) =>
  content
    .map((part) => (part.type === "text" ? part.text : `[${part.mime}${part.name === undefined ? "" : `: ${part.name}`}]`))
    .join("\n")

export type Candidate = {
  readonly call_id: string
  readonly tool: string
  readonly status: string
  readonly message_id: string
  readonly seq: number
  readonly input?: string
  readonly preview?: string
  readonly error?: string
  readonly haystack: string
}

const toolCandidates = (message: SessionMessage.Assistant, seq: number): readonly Candidate[] =>
  message.content.flatMap((item) => {
    if (item.type !== "tool") return []
    const state = item.state
    const input = inputSummary(state.input)
    const preview =
      state.status === "completed" || state.status === "error" ? bound(contentText(state.content), PREVIEW_CHARS) : undefined
    const error = state.status === "error" ? bound(state.error.message, PREVIEW_CHARS) : undefined
    return [
      {
        call_id: item.id,
        tool: item.name,
        status: state.status,
        message_id: message.id,
        seq,
        ...(input === undefined ? {} : { input }),
        ...(preview === undefined ? {} : { preview }),
        ...(error === undefined ? {} : { error }),
        haystack: [input, preview, error].filter((part): part is string => part !== undefined).join("\n"),
      },
    ]
  })

const shellCandidate = (message: SessionMessage.Shell, seq: number): Candidate => {
  const preview = bound(message.output, PREVIEW_CHARS)
  return {
    call_id: message.callID,
    tool: "bash",
    status: "completed",
    message_id: message.id,
    seq,
    input: bound(message.command, INPUT_SUMMARY_CHARS),
    preview,
    haystack: `${message.command}\n${message.output}`,
  }
}

export const collectCandidates = (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
): Effect.Effect<readonly Candidate[]> =>
  Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    const candidates: Candidate[] = []
    for (const row of rows) {
      const message = yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!message) continue
      if (message.type === "shell") candidates.push(shellCandidate(message, row.seq))
      else if (message.type === "assistant") candidates.push(...toolCandidates(message, row.seq))
    }
    return candidates
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const db = (yield* Database.Service).db

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search tool calls in this session by tool name, status or pattern. " +
            "Returns compact entries (call_id, status, input, preview) so you can locate a call and then load its full " +
            "output with get_tool_call_details(call_id). Compacted [mem:compacted] results are searchable here because " +
            "the originals live in session history.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const regex = yield* Effect.try({
                try: () => (input.query === undefined ? undefined : new RegExp(input.query, "i")),
                catch: () => new ToolFailure({ message: `Invalid query regular expression: ${input.query}` }),
              })
              const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
              const candidates = yield* collectCandidates(db, context.sessionID)
              const matched = candidates.filter((candidate) => {
                if (input.tool !== undefined && candidate.tool !== input.tool) return false
                if (input.status !== undefined && candidate.status !== input.status) return false
                if (regex !== undefined && !regex.test(candidate.haystack)) return false
                return true
              })
              const calls = matched
                .slice(-limit)
                .reverse()
                .map((candidate) => ({
                  call_id: candidate.call_id,
                  tool: candidate.tool,
                  status: candidate.status,
                  message_id: candidate.message_id,
                  seq: candidate.seq,
                  ...(candidate.input === undefined ? {} : { input: candidate.input }),
                  ...(candidate.preview === undefined ? {} : { preview: candidate.preview }),
                  ...(candidate.error === undefined ? {} : { error: candidate.error }),
                }))
              return { calls, matched: matched.length }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to search tool calls in session ${context.sessionID}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/find-tool-calls",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Database.node],
})
