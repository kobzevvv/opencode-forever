import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { collectCandidates, type Candidate } from "./find-tool-calls"
import * as Tool from "./tool"

const DEFAULT_GROUPS = 20
const MAX_GROUPS = 50
const DEFAULT_EXAMPLES = 2
const MAX_EXAMPLES = 5
const EXAMPLE_INPUT_CHARS = 160
const EXAMPLE_ERROR_CHARS = 120

export const Parameters = Schema.Struct({
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

type Metadata = { total: number }

const bound = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max))

export const GetToolCallOverviewTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "get_tool_call_overview",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    return {
      description:
        "Summarize tool usage in this session: one group per tool name with call counts by status and a few " +
        "recent example calls (call_id, status, input). Use it first to see what ran, then find_tool_calls to " +
        "locate individual calls and get_tool_call_details(call_id) to load a full original output. Compacted " +
        "[mem:compacted] results are counted here because the originals live in session history.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "get_tool_call_overview",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const matched = (yield* collectCandidates(db, ctx.sessionID)).filter((item) => {
            if (params.tool !== undefined && item.tool !== params.tool) return false
            if (params.status !== undefined && item.status !== params.status) return false
            return true
          })
          const grouped = new Map<string, Candidate[]>()
          for (const item of matched) {
            const items = grouped.get(item.tool)
            if (items === undefined) grouped.set(item.tool, [item])
            else items.push(item)
          }
          const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_GROUPS, MAX_GROUPS))
          const examples = Math.max(1, Math.min(params.examples ?? DEFAULT_EXAMPLES, MAX_EXAMPLES))
          const groups = [...grouped.entries()]
            .map(([tool, items]) => {
              const counts = new Map<string, number>()
              for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1)
              return {
                tool,
                count: items.length,
                statuses: [...counts.entries()]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([status, count]) => ({ status, count })),
                examples: items.slice(-examples).reverse().map((item) => ({
                  call_id: item.call_id,
                  status: item.status,
                  ...(item.input === undefined ? {} : { input: bound(item.input, EXAMPLE_INPUT_CHARS) }),
                  ...(item.error === undefined ? {} : { error: bound(item.error, EXAMPLE_ERROR_CHARS) }),
                })),
              }
            })
            .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
          const output = {
            total: matched.length,
            groups_total: groups.length,
            groups: groups.slice(0, limit),
          }
          return {
            title: `${output.total} tool calls across ${output.groups_total} tools`,
            output: JSON.stringify(output, null, 2),
            metadata: { total: output.total },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
