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
import { GetToolCallOverviewTool } from "@opencode-ai/core/tool/get-tool-call-overview"
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
    LayerNode.group([Database.node, ToolRegistry.node, ToolRegistry.toolsNode, GetToolCallOverviewTool.node]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_overview_test")
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
      slug: "overview",
      directory: "/project",
      title: "overview",
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
    ])
    .run()
    .pipe(Effect.orDie)
})

const call = (input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_overview", name: GetToolCallOverviewTool.name, input },
})

const parsed = (result: { type: string; value: unknown }) => {
  if (result.type !== "text" && result.type !== "json") throw new Error(`unexpected result type: ${result.type}`)
  return typeof result.value === "string" ? (JSON.parse(result.value) as Record<string, unknown>) : (result.value as Record<string, unknown>)
}

type Group = { tool: string; count: number; statuses: { status: string; count: number }[]; examples: Record<string, unknown>[] }

const groupsOf = (output: Record<string, unknown>) => output["groups"] as Group[]

describe("GetToolCallOverviewTool", () => {
  it.effect("groups calls by tool with status counts, busiest first", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({})))
      expect(output["total"]).toBe(4)
      expect(output["groups_total"]).toBe(2)
      const groups = groupsOf(output)
      expect(groups.map((group) => group.tool)).toEqual(["bash", "read"])
      expect(groups[0]!.count).toBe(3)
      expect(groups[0]!.statuses).toEqual([
        { status: "completed", count: 2 },
        { status: "error", count: 1 },
      ])
      expect(groups[1]!.count).toBe(1)
      expect(groups[1]!.statuses).toEqual([{ status: "completed", count: 1 }])
    }),
  )

  it.effect("shows the most recent calls as examples", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({})))
      const bash = groupsOf(output)[0]!
      expect(bash.examples.map((example) => example["call_id"])).toEqual(["call_shell_1", "call_bash_fail"])
      expect(bash.examples[0]!["input"]).toContain("git status")
      expect(bash.examples[1]!["status"]).toBe("error")
      expect(bash.examples[1]!["error"]).toContain("exit code 2")
    }),
  )

  it.effect("filters by tool and status", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const byTool = parsed(yield* executeTool(registry, call({ tool: "read" })))
      expect(byTool["total"]).toBe(1)
      expect(groupsOf(byTool).map((group) => group.tool)).toEqual(["read"])
      const byStatus = parsed(yield* executeTool(registry, call({ status: "error" })))
      expect(byStatus["total"]).toBe(1)
      const groups = groupsOf(byStatus)
      expect(groups[0]!.tool).toBe("bash")
      expect(groups[0]!.statuses).toEqual([{ status: "error", count: 1 }])
    }),
  )

  it.effect("limits groups but reports the full group total", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ limit: 1 })))
      expect(output["groups_total"]).toBe(2)
      expect(groupsOf(output).length).toBe(1)
    }),
  )

  it.effect("bounds examples per group", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const one = parsed(yield* executeTool(registry, call({ examples: 1 })))
      expect(groupsOf(one)[0]!.examples.length).toBe(1)
      const clamped = parsed(yield* executeTool(registry, call({ examples: 99 })))
      expect(groupsOf(clamped)[0]!.examples.length).toBeLessThanOrEqual(5)
      const bounded = groupsOf(clamped)[0]!.examples[0]!
      expect(String(bounded["input"] ?? "").length).toBeLessThanOrEqual(160)
    }),
  )

  it.effect("returns an empty overview when nothing matches", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ tool: "webfetch" })))
      expect(output["total"]).toBe(0)
      expect(output["groups_total"]).toBe(0)
      expect(groupsOf(output).length).toBe(0)
    }),
  )
})
