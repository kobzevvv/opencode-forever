import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable, MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { GetToolCallDetailsTool } from "../../src/tool/get-tool-call-details"
import { FindToolCallsTool } from "../../src/tool/find-tool-calls"
import { GetToolCallOverviewTool } from "../../src/tool/get-tool-call-overview"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, Truncate.node, Agent.node])))

const sessionID = SessionID.make("ses_v1_retrieval_test")

const toolPart = (args: {
  id: string
  tool: string
  output?: string
  error?: string
  input?: Record<string, unknown>
}) => ({
  id: PartID.make(`prt_${args.id}`),
  message_id: MessageID.make(`msg_${args.id}`),
  session_id: sessionID,
  time_created: 0,
  data: {
    type: "tool" as const,
    callID: args.id,
    tool: args.tool,
    state:
      args.error === undefined
        ? {
            status: "completed",
            input: args.input ?? {},
            output: args.output ?? "",
            title: args.tool,
            metadata: {},
            time: { start: 0, end: 1 },
          }
        : { status: "error", input: args.input ?? {}, error: args.error, time: { start: 0, end: 1 } },
  },
})

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "v1-retrieval",
      directory: AbsolutePath.make("/project"),
      title: "test",
      version: "0.0.0",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(MessageTable)
    .values(
      ["call_big", "call_err", "call_small"].map((id) => ({
        id: MessageID.make(`msg_${id}`),
        session_id: sessionID,
        time_created: 0,
        data: { role: "assistant" as const, agent: "build", time: { created: 0 } },
      })),
    )
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(PartTable)
    .values([
      toolPart({ id: "call_big", tool: "bash", output: "x".repeat(5000), input: { command: "cat big.txt" } }),
      toolPart({ id: "call_err", tool: "bash", error: "exit code 1", input: { command: "npm test" } }),
      toolPart({ id: "call_small", tool: "read", output: "ok", input: { path: "a.ts" } }),
    ])
    .run()
    .pipe(Effect.orDie)
})

const ctx = (sid: SessionID): Tool.Context => ({
  sessionID: sid,
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("tool.get-tool-call-details (V1)", () => {
  it.instance("returns full output by call_id from PartTable", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallDetailsTool)
      const result = yield* def.execute({ call_id: "call_big" }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.found).toBe(true)
      expect(parsed.tool).toBe("bash")
      expect(parsed.command).toBe("cat big.txt")
      expect(parsed.output).toBe("x".repeat(5000))
      expect(parsed.truncated).toBe(false)
    }),
  )

  it.instance("respects max_chars", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallDetailsTool)
      const result = yield* def.execute({ call_id: "call_big", max_chars: 100 }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.output.length).toBe(100)
      expect(parsed.truncated).toBe(true)
    }),
  )

  it.instance("returns error state output", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallDetailsTool)
      const result = yield* def.execute({ call_id: "call_err" }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.found).toBe(true)
      expect(parsed.status).toBe("error")
      expect(parsed.output).toContain("exit code 1")
    }),
  )

  it.instance("returns found=false for unknown call_id", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallDetailsTool)
      const result = yield* def.execute({ call_id: "call_missing" }, ctx(sessionID))
      expect(JSON.parse(result.output)).toEqual({ found: false, call_id: "call_missing" })
    }),
  )

  it.instance("scopes lookup to the session", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallDetailsTool)
      const result = yield* def.execute({ call_id: "call_big" }, ctx(SessionID.make("ses_other")))
      expect(JSON.parse(result.output).found).toBe(false)
    }),
  )
})

describe("tool.find-tool-calls (V1)", () => {
  it.instance("lists tool calls newest-first", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* FindToolCallsTool)
      const result = yield* def.execute({}, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(3)
      expect(parsed.calls.map((call: { call_id: string }) => call.call_id)).toEqual([
        "call_small",
        "call_err",
        "call_big",
      ])
    }),
  )

  it.instance("filters by tool and status", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* FindToolCallsTool)
      const result = yield* def.execute({ tool: "bash", status: "error" }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(1)
      expect(parsed.calls[0].call_id).toBe("call_err")
    }),
  )

  it.instance("filters by regex query over input and output", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* FindToolCallsTool)
      const result = yield* def.execute({ query: "npm test" }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(1)
      expect(parsed.calls[0].call_id).toBe("call_err")
    }),
  )

  it.instance("bounds previews", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* FindToolCallsTool)
      const result = yield* def.execute({ tool: "bash", status: "completed" }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.calls[0].preview.length).toBeLessThanOrEqual(240)
    }),
  )

  it.instance("respects limit", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* FindToolCallsTool)
      const result = yield* def.execute({ limit: 1 }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.calls.length).toBe(1)
      expect(parsed.matched).toBe(3)
    }),
  )

  it.instance("redacts secrets in model-visible fields but keeps details retrieval unredacted", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      yield* db
        .insert(MessageTable)
        .values({
          id: MessageID.make("msg_call_secret"),
          session_id: sessionID,
          time_created: 1,
          data: { role: "assistant" as const, agent: "build", time: { created: 0 } },
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values([
          toolPart({
            id: "call_secret",
            tool: "bash",
            output: "deploy failed with key sk-proj-abcdef1234567890ABCDEF",
            input: { command: 'curl -H "Authorization: Bearer ghp_abcdefghij1234567890ABCD" https://api.example.com' },
          }),
        ])
        .run()
        .pipe(Effect.orDie)
      const find = yield* Tool.init(yield* FindToolCallsTool)
      const parsed = JSON.parse((yield* find.execute({ query: "deploy failed" }, ctx(sessionID))).output)
      expect(parsed.matched).toBe(1)
      const entry = parsed.calls[0]
      expect(entry.call_id).toBe("call_secret")
      expect(entry.preview).not.toContain("sk-proj-abcdef")
      expect(entry.preview).toContain("[REDACTED:api_key]")
      expect(entry.input).not.toContain("ghp_abcdefghij")
      expect(entry.input).toContain("[REDACTED:bearer]")
      const bySecret = JSON.parse((yield* find.execute({ query: "sk-proj-abcdef1234567890ABCDEF" }, ctx(sessionID))).output)
      expect(bySecret.matched).toBe(1)
      const details = yield* Tool.init(yield* GetToolCallDetailsTool)
      const full = JSON.parse((yield* details.execute({ call_id: "call_secret" }, ctx(sessionID))).output)
      expect(full.output).toContain("sk-proj-abcdef1234567890ABCDEF")
    }),
  )
})

describe("tool.get-tool-call-overview (V1)", () => {
  it.instance("groups by tool with status counts, busiest first", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallOverviewTool)
      const result = yield* def.execute({}, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.total).toBe(3)
      expect(parsed.groups_total).toBe(2)
      expect(parsed.groups.map((group: { tool: string }) => group.tool)).toEqual(["bash", "read"])
      expect(parsed.groups[0].count).toBe(2)
      expect(parsed.groups[0].statuses).toEqual([
        { status: "completed", count: 1 },
        { status: "error", count: 1 },
      ])
      expect(parsed.groups[1].count).toBe(1)
    }),
  )

  it.instance("shows recent example calls retrievable by call_id", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallOverviewTool)
      const result = yield* def.execute({}, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      const examples = parsed.groups[0].examples
      expect(examples.map((example: { call_id: string }) => example.call_id)).toEqual(["call_err", "call_big"])
      expect(examples[0].error).toContain("exit code 1")
      const details = yield* Tool.init(yield* GetToolCallDetailsTool)
      const full = yield* details.execute({ call_id: examples[1].call_id }, ctx(sessionID))
      expect(JSON.parse(full.output).found).toBe(true)
    }),
  )

  it.instance("filters by tool and status", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallOverviewTool)
      const byTool = JSON.parse((yield* def.execute({ tool: "read" }, ctx(sessionID))).output)
      expect(byTool.total).toBe(1)
      expect(byTool.groups.map((group: { tool: string }) => group.tool)).toEqual(["read"])
      const byStatus = JSON.parse((yield* def.execute({ status: "error" }, ctx(sessionID))).output)
      expect(byStatus.total).toBe(1)
      expect(byStatus.groups[0].statuses).toEqual([{ status: "error", count: 1 }])
    }),
  )

  it.instance("limits groups and bounds examples", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallOverviewTool)
      const limited = JSON.parse((yield* def.execute({ limit: 1 }, ctx(sessionID))).output)
      expect(limited.groups_total).toBe(2)
      expect(limited.groups.length).toBe(1)
      const bounded = JSON.parse((yield* def.execute({ examples: 1 }, ctx(sessionID))).output)
      expect(bounded.groups[0].examples.length).toBe(1)
      expect(String(bounded.groups[0].examples[0].input ?? "").length).toBeLessThanOrEqual(160)
    }),
  )

  it.instance("scopes the overview to the session", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallOverviewTool)
      const result = yield* def.execute({}, ctx(SessionID.make("ses_overview_other")))
      const parsed = JSON.parse(result.output)
      expect(parsed.total).toBe(0)
      expect(parsed.groups.length).toBe(0)
    }),
  )
})
