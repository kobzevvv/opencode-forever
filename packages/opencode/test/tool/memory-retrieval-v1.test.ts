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
    type: "tool",
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
        data: { role: "assistant" },
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
  it.effect("returns full output by call_id from PartTable", () =>
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

  it.effect("respects max_chars", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallDetailsTool)
      const result = yield* def.execute({ call_id: "call_big", max_chars: 100 }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.output.length).toBe(100)
      expect(parsed.truncated).toBe(true)
    }),
  )

  it.effect("returns error state output", () =>
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

  it.effect("returns found=false for unknown call_id", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallDetailsTool)
      const result = yield* def.execute({ call_id: "call_missing" }, ctx(sessionID))
      expect(JSON.parse(result.output)).toEqual({ found: false, call_id: "call_missing" })
    }),
  )

  it.effect("scopes lookup to the session", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* GetToolCallDetailsTool)
      const result = yield* def.execute({ call_id: "call_big" }, ctx(SessionID.make("ses_other")))
      expect(JSON.parse(result.output).found).toBe(false)
    }),
  )
})

describe("tool.find-tool-calls (V1)", () => {
  it.effect("lists tool calls newest-first", () =>
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

  it.effect("filters by tool and status", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* FindToolCallsTool)
      const result = yield* def.execute({ tool: "bash", status: "error" }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(1)
      expect(parsed.calls[0].call_id).toBe("call_err")
    }),
  )

  it.effect("filters by regex query over input and output", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* FindToolCallsTool)
      const result = yield* def.execute({ query: "npm test" }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(1)
      expect(parsed.calls[0].call_id).toBe("call_err")
    }),
  )

  it.effect("bounds previews", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* FindToolCallsTool)
      const result = yield* def.execute({ tool: "bash", status: "completed" }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.calls[0].preview.length).toBeLessThanOrEqual(240)
    }),
  )

  it.effect("respects limit", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* FindToolCallsTool)
      const result = yield* def.execute({ limit: 1 }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.calls.length).toBe(1)
      expect(parsed.matched).toBe(3)
    }),
  )
})
