import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MemoryContext } from "@opencode-ai/core/session/memory-context"

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const big = (size = 3000) => "x".repeat(size)

const user = (value: string) =>
  SessionMessage.User.make({ id: id(value), type: "user", text: "prompt", time: { created } })

const completedTool = (args: {
  id: string
  name: string
  content: readonly { type: "text"; text: string }[]
  input?: Record<string, unknown>
}) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: args.id,
    name: args.name,
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: args.input ?? {},
      content: args.content,
      structured: {},
    }),
    time: { created },
  })

const assistant = (value: string, content: SessionMessage.Assistant["content"]) =>
  SessionMessage.Assistant.make({
    id: id(value),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content,
    time: { created, completed: created },
  })

const compact = (messages: readonly SessionMessage.Message[], overrides?: Partial<MemoryContext.Options>) =>
  MemoryContext.project(messages, { enabled: true, minOutputChars: 100, keepRecentUserTurns: 1, ...overrides })

const toolText = (message: SessionMessage.Message, index = 0) => {
  if (message.type !== "assistant") throw new Error("expected assistant")
  const item = message.content[index]
  if (item === undefined || item.type !== "tool") throw new Error("expected tool")
  if (item.state.status !== "completed") throw new Error("expected completed")
  const text = item.state.content[0]
  if (text === undefined || text.type !== "text") throw new Error("expected text content")
  return text.text
}

describe("MemoryContext.project", () => {
  test("disabled flag returns identical array", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }] })])]
    expect(MemoryContext.project(messages, { enabled: false })).toBe(messages)
  })

  test("compacts old bash result into retrieval marker", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }], input: { command: "npm test" } })]), user("u2")]
    const projected = compact(messages)
    const marker = toolText(projected[1]!)
    expect(marker).toContain("[mem:compacted tool result]")
    expect(marker).toContain("kind=bash")
    expect(marker).toContain("call_id=call_1")
    expect(marker).toContain("command=npm test")
    expect(marker).toContain("get_tool_call_details")
    expect(marker.length).toBeLessThan(1000)
  })

  test("keeps original messages untouched", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }] })]), user("u2")]
    const before = toolText(messages[1]!)
    compact(messages)
    expect(toolText(messages[1]!)).toBe(before)
  })

  test("never compacts the protected recent turn", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }] })])]
    const projected = compact(messages)
    expect(toolText(projected[1]!)).toBe(big())
  })

  test("does not compact failed tool results", () => {
    const failed = SessionMessage.AssistantTool.make({
      type: "tool",
      id: "call_err",
      name: "bash",
      state: SessionMessage.ToolStateError.make({
        status: "error",
        input: {},
        content: [{ type: "text", text: big() }],
        structured: {},
        error: { type: "unknown", message: "boom" },
      }),
      time: { created },
    })
    const messages = [user("u1"), assistant("a1", [failed]), user("u2")]
    const projected = compact(messages)
    const item = (projected[1] as SessionMessage.Assistant).content[0]
    if (item === undefined || item.type !== "tool" || item.state.status !== "error") throw new Error("expected error tool")
    expect(item.state.content[0]).toEqual({ type: "text", text: big() })
  })

  test("detects url and artifact kinds", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        completedTool({ id: "call_u", name: "webfetch", content: [{ type: "text", text: big() }], input: { url: "https://example.com" } }),
      ]),
      assistant("a2", [
        completedTool({ id: "call_j", name: "read", content: [{ type: "text", text: big() }], input: { path: "docs/report.json" } }),
      ]),
      user("u2"),
    ]
    const projected = compact(messages)
    expect(toolText(projected[1]!)).toContain("kind=url")
    expect(toolText(projected[1]!)).toContain("url=https://example.com")
    expect(toolText(projected[2]!)).toContain("kind=artifact")
    expect(toolText(projected[2]!)).toContain("path=docs/report.json")
  })

  test("never compacts memory tools", () => {
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_m", name: "search_operational_memory", content: [{ type: "text", text: big() }] })]),
      user("u2"),
    ]
    const projected = compact(messages)
    expect(toolText(projected[1]!)).toBe(big())
  })

  test("compacts large shell output", () => {
    const shell = SessionMessage.Shell.make({
      id: id("sh1"),
      type: "shell",
      callID: "call_sh",
      command: "npm run build",
      output: big(),
      time: { created },
    })
    const messages = [user("u1"), shell, user("u2")]
    const projected = compact(messages)
    const message = projected[1]
    if (message === undefined || message.type !== "shell") throw new Error("expected shell")
    expect(message.output).toContain("[mem:compacted shell output]")
    expect(message.output).toContain("command=npm run build")
    expect(message.command).toBe("npm run build")
  })

  test("respects minOutputChars", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_s", name: "bash", content: [{ type: "text", text: "short" }] })]), user("u2")]
    const projected = compact(messages, { minOutputChars: 2000 })
    expect(toolText(projected[1]!)).toBe("short")
  })
})
