import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MemoryContext } from "@opencode-ai/core/session/memory-context"

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)

const WORDS = [
  "assert",
  "handler",
  "session",
  "provider",
  "request",
  "response",
  "cache",
  "token",
  "context",
  "message",
  "result",
  "status",
  "error",
  "retry",
  "queue",
  "worker",
]

const text = (words: number) => {
  let out = ""
  for (let i = 0; i < words; i++) out += (i === 0 ? "" : " ") + WORDS[i % WORDS.length]
  return out
}

const user = (value: string) =>
  SessionMessage.User.make({ id: id(value), type: "user", text: "continue the task", time: { created } })

const completedTool = (args: {
  id: string
  name: string
  words: number
  input?: Record<string, unknown>
}) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: args.id,
    name: args.name,
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: args.input ?? {},
      content: [{ type: "text", text: text(args.words) }],
      structured: {},
    }),
    time: { created },
  })

const failedTool = (args: { id: string; name: string; words: number }) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: args.id,
    name: args.name,
    state: SessionMessage.ToolStateError.make({
      status: "error",
      input: {},
      content: [{ type: "text", text: text(args.words) }],
      structured: {},
      error: { type: "unknown", message: "command failed" },
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

// Tool-heavy session: five old successful tool results, one old failure and
// one recent untouched turn. Shapes match a realistic bash/read/webfetch run.
const session = () => [
  user("u1"),
  assistant("a1", [
    completedTool({ id: "call_1", name: "bash", words: 1600, input: { command: "bun test" } }),
    completedTool({ id: "call_2", name: "read", words: 1400, input: { path: "docs/report.md" } }),
  ]),
  user("u2"),
  assistant("a2", [
    completedTool({ id: "call_3", name: "webfetch", words: 1500, input: { url: "https://example.com/api" } }),
    completedTool({ id: "call_4", name: "bash", words: 1200, input: { command: "bun turbo build" } }),
  ]),
  user("u3"),
  assistant("a3", [failedTool({ id: "call_5", name: "bash", words: 900 })]),
  user("u4"),
  assistant("a4", [completedTool({ id: "call_6", name: "bash", words: 1600, input: { command: "git push" } })]),
  user("u5"),
]

const toolPayloadLength = (messages: readonly SessionMessage.Message[]) =>
  messages.reduce((sum, message) => {
    if (message.type === "shell") return sum + message.output.length
    if (message.type !== "assistant") return sum
    return (
      sum +
      message.content.reduce((inner, item) => {
        if (item.type !== "tool") return inner
        if (item.state.status !== "completed" && item.state.status !== "error") return inner
        return inner + item.state.content.reduce((n, part) => (part.type === "text" ? n + part.text.length : n), 0)
      }, 0)
    )
  }, 0)

const serialized = (messages: readonly SessionMessage.Message[]) => JSON.stringify(messages).length

const toolTexts = (message: SessionMessage.Message) => {
  if (message.type !== "assistant") return []
  return message.content.flatMap((item) =>
    item.type === "tool" && item.state.status !== "pending" && item.state.status !== "running"
      ? item.state.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  )
}

describe("MemoryContext savings", () => {
  test("reduces serialized request size on a tool-heavy session", () => {
    const messages = session()
    const projected = MemoryContext.project(messages, { enabled: true })
    const before = serialized(messages)
    const after = serialized(projected)
    const saved = (before - after) / before
    const toolBefore = toolPayloadLength(messages)
    const toolAfter = toolPayloadLength(projected)
    const toolSaved = (toolBefore - toolAfter) / toolBefore

    console.log(
      `[mem-context-savings] bytes ${before} -> ${after} (saved ${(saved * 100).toFixed(1)}%), tool payload saved ${(toolSaved * 100).toFixed(1)}%`,
    )

    expect(saved).toBeGreaterThanOrEqual(0.4)
    expect(toolSaved).toBeGreaterThanOrEqual(0.6)
    expect(after).toBeLessThan(before)
  })

  test("keeps every compacted result retrievable by call_id", () => {
    const projected = MemoryContext.project(session(), { enabled: true })
    const markers = projected.flatMap(toolTexts).filter((value) => value.startsWith("[mem:compacted tool result]"))
    expect(markers.length).toBeGreaterThanOrEqual(4)
    for (const marker of markers) {
      expect(marker).toMatch(/call_id=call_\d+/)
      expect(marker).toContain("retrieve=get_tool_call_details(call_id=")
      expect(marker).toContain("full text kept in SQLite history")
    }
    const ids = markers.map((marker) => /call_id=(call_\d+)/.exec(marker)![1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("leaves failure, recent turn and small results intact", () => {
    const messages = session()
    const projected = MemoryContext.project(messages, { enabled: true })

    const failed = toolTexts(projected[5])[0]
    expect(failed).toContain(WORDS[0])
    expect(failed).not.toContain("[mem:compacted")

    const recent = toolTexts(projected[7])[0]
    expect(recent).not.toContain("[mem:compacted")

    expect(toolTexts(projected[1])[0]).toContain("[mem:compacted tool result]")
  })

  test("flag off leaves request byte-identical", () => {
    const messages = session()
    expect(JSON.stringify(MemoryContext.project(messages, { enabled: false }))).toBe(JSON.stringify(messages))
  })
})
