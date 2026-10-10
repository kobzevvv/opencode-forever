export * as GetToolCallDetailsTool from "./get-tool-call-details"

import { and, asc, eq } from "drizzle-orm"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionMessageTable } from "../session/sql"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "get_tool_call_details"

const DEFAULT_MAX_CHARS = 8000

export const Input = Schema.Struct({
  call_id: Schema.String.annotate({ description: "Call ID of the tool call to retrieve (from a compacted marker)" }),
  max_chars: Schema.optional(
    Schema.Number.annotate({ description: `Maximum characters of output text (default ${DEFAULT_MAX_CHARS})` }),
  ),
})

export const Output = Schema.Struct({
  found: Schema.Boolean,
  call_id: Schema.String,
  tool: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  message_id: Schema.optional(Schema.String),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output, null, 2)

const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

const bound = (text: string, max: number) =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true }

const extract = (
  message: SessionMessage.Message,
  callID: string,
  maxChars: number,
): Output | undefined => {
  if (message.type === "shell" && message.callID === callID) {
    const output = bound(message.output, maxChars)
    return {
      found: true,
      call_id: callID,
      tool: "bash",
      status: "completed",
      command: message.command,
      output: output.text,
      truncated: output.truncated,
      message_id: message.id,
    }
  }
  if (message.type !== "assistant") return undefined
  const item = message.content.find(
    (content): content is SessionMessage.AssistantTool => content.type === "tool" && content.id === callID,
  )
  if (!item) return undefined
  if (item.state.status === "pending" || item.state.status === "running")
    return {
      found: true,
      call_id: callID,
      tool: item.name,
      status: item.state.status,
      message_id: message.id,
    }
  const text =
    item.state.status === "error"
      ? `${item.state.error.message}\n\n${item.state.content
          .map((part) => (part.type === "text" ? part.text : `[${part.mime}]`))
          .join("\n")}`
      : item.state.content
          .map((part) => (part.type === "text" ? part.text : `[${part.mime}${part.name === undefined ? "" : `: ${part.name}`}]`))
          .join("\n")
  const output = bound(text, maxChars)
  return {
    found: true,
    call_id: callID,
    tool: item.name,
    status: item.state.status,
    output: output.text,
    truncated: output.truncated,
    message_id: message.id,
  }
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const db = (yield* Database.Service).db

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Retrieve the full original output of a previous tool call in this session by its call_id. " +
            "Use this when a tool result was compacted to a [mem:compacted tool result] marker.",
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
              const maxChars = input.max_chars ?? DEFAULT_MAX_CHARS
              const rows = yield* db
                .select()
                .from(SessionMessageTable)
                .where(
                  and(
                    eq(SessionMessageTable.session_id, context.sessionID),
                    eq(SessionMessageTable.type, "assistant"),
                  ),
                )
                .orderBy(asc(SessionMessageTable.seq))
                .all()
                .pipe(Effect.orDie)
              for (const row of rows) {
                const message = yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                )
                if (!message) continue
                const found = extract(message, input.call_id, maxChars)
                if (found) return found
              }
              const shells = yield* db
                .select()
                .from(SessionMessageTable)
                .where(and(eq(SessionMessageTable.session_id, context.sessionID), eq(SessionMessageTable.type, "shell")))
                .orderBy(asc(SessionMessageTable.seq))
                .all()
                .pipe(Effect.orDie)
              for (const row of shells) {
                const message = yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                )
                if (!message) continue
                const found = extract(message, input.call_id, maxChars)
                if (found) return found
              }
              return { found: false, call_id: input.call_id }
            }).pipe(
              Effect.mapError(() => new ToolFailure({ message: `Unable to retrieve tool call ${input.call_id}` })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/get-tool-call-details",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Database.node],
})
