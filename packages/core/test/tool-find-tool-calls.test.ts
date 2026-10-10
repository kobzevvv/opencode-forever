import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { FindToolCallsTool } from "@opencode-ai/core/tool/find-tool-calls"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, ToolRegistry.node, ToolRegistry.toolsNode, FindToolCallsTool.node]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_find_tool_calls_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (id: SessionMessage.ID, seq: number, content: SessionMessage.Assistant["content"]) => {
  const { id: _id, type, ...data } = encodeMessage(
    SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content, time: { created } }),
  )
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(created), data }
}

const shellRow = (id: SessionMessage.ID, seq: number, callID: string, command: string, output: string) => {
  const { id: _id, type, ...data } = encodeMessage(
    SessionMessage.Shell.make({
      id,
      type: "shell",
      callID,
      command,
      output,
      time: { created },
    }),
  )
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(created), data }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "find-tool-calls",
      directory: "/project",
      title: "find-tool-calls",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionMessageTable)
    .values([
      assistantRow(SessionMessage.ID.make("msg_call_1"), 1, [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_bash_ok",
          name: "bash",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { command: "npm test" },
            content: [{ type: "text", text: "all tests passed" }],
            structured: {},
          }),
          time: { created },
        }),
      ]),
      assistantRow(SessionMessage.ID.make("msg_call_2"), 2, [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_bash_fail",
          name: "bash",
          state: SessionMessage.ToolStateError.make({
            status: "error",
            input: { command: "npm run build" },
            content: [{ type: "text", text: "tsc failed" }],
            structured: {},
            error: { type: "unknown", message: "exit code 2" },
          }),
          time: { created },
        }),
      ]),
      assistantRow(SessionMessage.ID.make("msg_call_3"), 3, [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_read",
          name: "read",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { filePath: "/project/package.json" },
            content: [{ type: "text", text: '{"name":"app"}' }],
            structured: {},
          }),
          time: { created },
        }),
      ]),
      shellRow(SessionMessage.ID.make("msg_shell_1"), 4, "call_shell_1", "git status", "nothing to commit"),
      assistantRow(SessionMessage.ID.make("msg_call_4"), 5, [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_secret",
          name: "bash",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { command: 'curl -H "Authorization: Bearer ghp_abcdefghij1234567890ABCD" https://api.example.com' },
            content: [{ type: "text", text: "deploy failed with key sk-proj-abcdef1234567890ABCDEF" }],
            structured: {},
          }),
          time: { created },
        }),
      ]),
    ])
    .run()
    .pipe(Effect.orDie)
})

const call = (input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_search", name: FindToolCallsTool.name, input },
})

const parsed = (result: { type: string; value: unknown }) => {
  if (result.type !== "text" && result.type !== "json") throw new Error(`unexpected result type: ${result.type}`)
  return typeof result.value === "string" ? (JSON.parse(result.value) as Record<string, unknown>) : (result.value as Record<string, unknown>)
}

const callsOf = (output: Record<string, unknown>) => output["calls"] as Record<string, unknown>[]

describe("FindToolCallsTool", () => {
  it.effect("returns all calls newest first when unfiltered", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({})))
      expect(output["matched"]).toBe(5)
      const calls = callsOf(output)
      expect(calls.length).toBe(5)
      expect(calls[0]!["tool"]).toBe("bash")
      expect(calls[0]!["call_id"]).toBe("call_secret")
      const shell = calls.find((candidate) => candidate["call_id"] === "call_shell_1")
      expect(String(shell?.["input"])).toContain("git status")
    }),
  )

  it.effect("filters by tool name and status", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ tool: "bash", status: "error" })))
      expect(output["matched"]).toBe(1)
      const calls = callsOf(output)
      expect(calls[0]!["call_id"]).toBe("call_bash_fail")
      expect(calls[0]!["status"]).toBe("error")
      expect(String(calls[0]!["error"])).toContain("exit code 2")
    }),
  )

  it.effect("query regex matches input, output and error text", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const byInput = callsOf(parsed(yield* executeTool(registry, call({ query: "npm (test|run)" }))))
      expect(byInput.map((candidate) => candidate["call_id"])).toEqual(["call_bash_fail", "call_bash_ok"])
      const byOutput = callsOf(parsed(yield* executeTool(registry, call({ query: "nothing to commit" }))))
      expect(byOutput.length).toBe(1)
      expect(byOutput[0]!["tool"]).toBe("bash")
      const byError = callsOf(parsed(yield* executeTool(registry, call({ query: "exit code" }))))
      expect(byError.map((candidate) => candidate["call_id"])).toEqual(["call_bash_fail"])
    }),
  )

  it.effect("respects limit and reports total matched", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ tool: "bash", limit: 1 })))
      expect(output["matched"]).toBe(4)
      const calls = callsOf(output)
      expect(calls.length).toBe(1)
      expect(calls[0]!["call_id"]).toBe("call_secret")
    }),
  )

  it.effect("bounds long previews", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ query: "all tests passed" })))
      const calls = callsOf(output)
      expect(calls[0]!["call_id"]).toBe("call_bash_ok")
      expect(String(calls[0]!["preview"]).length).toBeLessThanOrEqual(240)
    }),
  )

  it.effect("returns empty result for no matches", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ tool: "webfetch" })))
      expect(output["matched"]).toBe(0)
      expect(callsOf(output).length).toBe(0)
    }),
  )

  it.effect("rejects an invalid query regex", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ query: "(unclosed" }))
      expect(result.type).toBe("error")
    }),
  )

  it.effect("redacts secrets in model-visible fields but keeps them searchable", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ tool: "bash", query: "deploy failed" })))
      const entry = callsOf(output).find((candidate) => candidate["call_id"] === "call_secret")
      expect(entry).toBeDefined()
      expect(String(entry?.["preview"])).not.toContain("sk-proj-abcdef")
      expect(String(entry?.["preview"])).toContain("[REDACTED:api_key]")
      expect(String(entry?.["input"])).not.toContain("ghp_abcdefghij")
      expect(String(entry?.["input"])).toContain("[REDACTED:bearer]")
      const bySecret = callsOf(parsed(yield* executeTool(registry, call({ query: "sk-proj-abcdef1234567890ABCDEF" }))))
      expect(bySecret.map((candidate) => candidate["call_id"])).toEqual(["call_secret"])
    }),
  )
})
