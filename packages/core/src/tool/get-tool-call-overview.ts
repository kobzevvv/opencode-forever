export * as GetToolCallOverviewTool from "./get-tool-call-overview"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { collectCandidates, type Candidate } from "./find-tool-calls"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "get_tool_call_overview"

const DEFAULT_GROUPS = 20
const MAX_GROUPS = 50
const DEFAULT_EXAMPLES = 2
const MAX_EXAMPLES = 5
const EXAMPLE_INPUT_CHARS = 160
const EXAMPLE_ERROR_CHARS = 120

export const Input = Schema.Struct({
  tool: Schema.optional(Schema.String.annotate({ description: "Exact tool name to summarize by (e.g. bash, read)" })),
  status: Schema.optional(
    Schema.Literals(["pending", "running", "completed", "error"]).annotate({
      description: "Count only calls in this status",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: `Maximum tool groups returned, busiest first (default ${DEFAULT_GROUPS}, max ${MAX_GROUPS})`,
    }),
  ),
  examples: Schema.optional(
    Schema.Number.annotate({
      description: `Recent example calls shown per group (default ${DEFAULT_EXAMPLES}, max ${MAX_EXAMPLES})`,
    }),
  ),
})

export const Example = Schema.Struct({
  call_id: Schema.String,
  status: Schema.String,
  input: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

export const Group = Schema.Struct({
  tool: Schema.String,
  count: Schema.Number,
  statuses: Schema.Array(Schema.Struct({ status: Schema.String, count: Schema.Number })),
  examples: Schema.Array(Example),
})

export const Output = Schema.Struct({
  total: Schema.Number,
  groups_total: Schema.Number,
  groups: Schema.Array(Group),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output, null, 2)

const bound = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max))

const groupOf = (tool: string, items: readonly Candidate[], examples: number) => {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1)
  return {
    tool,
    count: items.length,
    statuses: [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => ({ status, count })),
    examples: items
      .slice(-examples)
      .reverse()
      .map((item) => ({
        call_id: item.call_id,
        status: item.status,
        ...(item.input === undefined ? {} : { input: bound(item.input, EXAMPLE_INPUT_CHARS) }),
        ...(item.error === undefined ? {} : { error: bound(item.error, EXAMPLE_ERROR_CHARS) }),
      })),
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
            "Summarize tool usage in this session: one group per tool name with call counts by status and a few " +
            "recent example calls (call_id, status, input). Use it first to see what ran, then find_tool_calls to " +
            "locate individual calls and get_tool_call_details(call_id) to load a full original output. Compacted " +
            "[mem:compacted] results are counted here because the originals live in session history.",
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
              const matched = (yield* collectCandidates(db, context.sessionID)).filter((candidate) => {
                if (input.tool !== undefined && candidate.tool !== input.tool) return false
                if (input.status !== undefined && candidate.status !== input.status) return false
                return true
              })
              const grouped = new Map<string, Candidate[]>()
              for (const candidate of matched) {
                const items = grouped.get(candidate.tool)
                if (items === undefined) grouped.set(candidate.tool, [candidate])
                else items.push(candidate)
              }
              const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_GROUPS, MAX_GROUPS))
              const examples = Math.max(1, Math.min(input.examples ?? DEFAULT_EXAMPLES, MAX_EXAMPLES))
              const groups = [...grouped.entries()]
                .map(([tool, items]) => groupOf(tool, items, examples))
                .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
              return { total: matched.length, groups_total: groups.length, groups: groups.slice(0, limit) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to summarize tool calls in session ${context.sessionID}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/get-tool-call-overview",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Database.node],
})
