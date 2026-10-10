import { Effect, Schema } from "effect"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable } from "@opencode-ai/core/session/sql"
import * as Tool from "./tool"

const DEFAULT_MAX_CHARS = 8000

export const Parameters = Schema.Struct({
  call_id: Schema.String.annotate({ description: "Call ID of the tool call to retrieve (from a compacted marker)" }),
  max_chars: Schema.optional(
    Schema.Number.annotate({ description: `Maximum characters of output text (default ${DEFAULT_MAX_CHARS})` }),
  ),
})

type Metadata = { found: boolean }

const bound = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max))

const extract = (data: unknown, callID: string, maxChars: number) => {
  if (typeof data !== "object" || data === null) return undefined
  const part = data as {
    type?: string
    callID?: string
    tool?: string
    state?: { status?: string; output?: string; error?: string; input?: Record<string, unknown> }
  }
  if (part.type !== "tool" || part.callID !== callID) return undefined
  const state = part.state
  const command = typeof state?.input?.command === "string" ? state.input.command : undefined
  if (state?.status === "error") {
    const text = [state.error, state.output].filter((piece): piece is string => typeof piece === "string").join("\n")
    return {
      found: true as const,
      call_id: callID,
      tool: part.tool,
      status: "error",
      ...(command === undefined ? {} : { command }),
      output: bound(text, maxChars),
      truncated: text.length > maxChars,
    }
  }
  const output = typeof state?.output === "string" ? state.output : ""
  return {
    found: true as const,
    call_id: callID,
    tool: part.tool,
    status: state?.status ?? "completed",
    ...(command === undefined ? {} : { command }),
    output: bound(output, maxChars),
    truncated: output.length > maxChars,
  }
}

export const GetToolCallDetailsTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "get_tool_call_details",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    return {
      description:
        "Retrieve the full original output of a previous tool call in this session by its call_id. " +
        "Use this when a tool result was compacted to a [mem:compacted tool result] marker.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "get_tool_call_details",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const maxChars = params.max_chars ?? DEFAULT_MAX_CHARS
          const rows = yield* db
            .select({ data: PartTable.data })
            .from(PartTable)
            .where(
              and(
                eq(PartTable.session_id, ctx.sessionID),
                sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
                sql`json_extract(${PartTable.data}, '$.callID') = ${params.call_id}`,
              ),
            )
            .limit(1)
            .all()
            .pipe(Effect.orDie)
          const row = rows[0]
          const found = row === undefined ? undefined : extract(row.data, params.call_id, maxChars)
          const output = found ?? { found: false as const, call_id: params.call_id }
          return {
            title: output.found ? `found ${output.tool ?? "tool"}` : "not found",
            output: JSON.stringify(output, null, 2),
            metadata: { found: output.found },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
