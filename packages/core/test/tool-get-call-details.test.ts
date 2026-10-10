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
import { GetToolCallDetailsTool } from "@opencode-ai/core/tool/get-tool-call-details"
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
    LayerNode.group([Database.node, ToolRegistry.node, ToolRegistry.toolsNode, GetToolCallDetailsTool.node]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_tool_call_details_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (id: SessionMessage.ID, seq: number, content: SessionMessage.Assistant["content"]) => {
  const { id: _id, type, ...data } = encodeMessage(
    SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content, time: { created } }),
  )
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(created), data }
}

const shellRow = (id: SessionMessage.ID, seq: number, command: string, output: string) => {
  const { id: _id, type, ...data } = encodeMessage(
    SessionMessage.Shell.make({
      id,
      type: "shell",
      callID: "call_shell_1",
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
      slug: "tool-call-details",
      directory: "/project",
      title: "tool-call-details",
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
          id: "call_1",
          name: "bash",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { command: "npm test" },
            content: [{ type: "text", text: "full original output\n".repeat(100) }],
            structured: {},
          }),
          time: { created },
        }),
      ]),
      assistantRow(SessionMessage.ID.make("msg_call_2"), 2, [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_2",
          name: "bash",
          state: SessionMessage.ToolStateError.make({
            status: "error",
            input: {},
            content: [{ type: "text", text: "stderr tail" }],
            structured: {},
            error: { type: "unknown", message: "command failed" },
          }),
          time: { created },
        }),
      ]),
      shellRow(SessionMessage.ID.make("msg_shell_1"), 3, "ls -la", "file1\nfile2\n"),
    ])
    .run()
    .pipe(Effect.orDie)
})

const call = (input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_retrieve", name: GetToolCallDetailsTool.name, input },
})

const parsed = (result: { type: string; value: unknown }) => {
  if (result.type !== "text" && result.type !== "json") throw new Error(`unexpected result type: ${result.type}`)
  return typeof result.value === "string" ? (JSON.parse(result.value) as Record<string, unknown>) : (result.value as Record<string, unknown>)
}

describe("GetToolCallDetailsTool", () => {
  it.effect("returns full original output by call_id", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ call_id: "call_1" })))
      expect(output["found"]).toBe(true)
      expect(output["tool"]).toBe("bash")
      expect(String(output["output"])).toContain("full original output")
    }),
  )

  it.effect("truncates output at max_chars", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ call_id: "call_1", max_chars: 16 })))
      expect(output["truncated"]).toBe(true)
      expect(String(output["output"]).length).toBe(16)
    }),
  )

  it.effect("returns error state with message", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ call_id: "call_2" })))
      expect(output["status"]).toBe("error")
      expect(String(output["output"])).toContain("command failed")
    }),
  )

  it.effect("finds shell output by call_id", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ call_id: "call_shell_1" })))
      expect(output["tool"]).toBe("bash")
      expect(output["command"]).toBe("ls -la")
      expect(String(output["output"])).toContain("file1")
    }),
  )

  it.effect("returns found=false for unknown call_id", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ call_id: "call_missing" })))
      expect(output["found"]).toBe(false)
    }),
  )
})
