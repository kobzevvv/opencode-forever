import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MemoryContext } from "@opencode-ai/core/session/memory-context"
import { SessionV1 } from "@opencode-ai/core/v1/session"

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

  test("tags PII categories in tool markers", () => {
    const text = `${big()} contact vova@example.com card 4111 1111 1111 1111`
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_p", name: "bash", content: [{ type: "text", text }] })]), user("u2")]
    const marker = toolText(compact(messages)[1]!)
    expect(marker).toContain("pii=email,credit_card")
    expect(marker).toContain("retrieve=get_tool_call_details")
  })

  test("omits pii tag for clean output", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_c", name: "bash", content: [{ type: "text", text: big() }] })]), user("u2")]
    expect(toolText(compact(messages)[1]!)).not.toContain("pii=")
  })

  test("tags PII in compacted shell output", () => {
    const shell = SessionMessage.Shell.make({
      id: id("sh2"),
      type: "shell",
      callID: "call_sh2",
      command: "cat contacts.txt",
      output: `${big()}\nadmin@site.org`,
      time: { created },
    })
    const messages = [user("u1"), shell, user("u2")]
    const message = compact(messages)[1]
    if (message === undefined || message.type !== "shell") throw new Error("expected shell")
    expect(message.output).toContain("pii=email")
  })

  test("redacts API keys from tool marker preview", () => {
    const secret = "sk-proj-abcdef1234567890ABCDEF"
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_r", name: "bash", content: [{ type: "text", text: `${big()} token ${secret}` }] })]),
      user("u2"),
    ]
    const marker = toolText(compact(messages)[1]!)
    expect(marker).not.toContain(secret)
    expect(marker).toContain("[REDACTED:api_key]")
    expect(marker).toContain("pii=api_key")
  })

  test("redacts secrets in shell marker command and preview", () => {
    const token = "ghp_abcdefghijklmnopqrstuv123456"
    const shell = SessionMessage.Shell.make({
      id: id("sh3"),
      type: "shell",
      callID: "call_sh3",
      command: `curl -H "Authorization: Bearer ${token}" https://api.example.com`,
      output: `${big()}\nfailed for ${token}`,
      time: { created },
    })
    const messages = [user("u1"), shell, user("u2")]
    const message = compact(messages)[1]
    if (message === undefined || message.type !== "shell") throw new Error("expected shell")
    expect(message.output).not.toContain(token)
    expect(message.output).toContain("[REDACTED:api_key]")
    expect(message.output).toContain("[mem:compacted shell output]")
    expect(message.command).toContain("[REDACTED:bearer]")
    expect(message.command).not.toContain(token)
  })

  test("redacts secret URL params in url kind summary", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        completedTool({
          id: "call_ur",
          name: "webfetch",
          content: [{ type: "text", text: big() }],
          input: { url: "https://api.example.com/data?api_key=abcdef1234567890&limit=5" },
        }),
      ]),
      user("u2"),
    ]
    const marker = toolText(compact(messages)[1]!)
    expect(marker).not.toContain("abcdef1234567890")
    expect(marker).toContain("api_key=[REDACTED:url_secret]")
    expect(marker).toContain("limit=5")
  })
})

const v1sid = "ses_v1_test"
const v1partBase = (messageID: string, id: string) => ({
  id: `prt_${id}`,
  sessionID: v1sid,
  messageID: `msg_${messageID}`,
})

const v1user = (value: string): SessionV1.WithParts => ({
  info: {
    id: `msg_${value}`,
    sessionID: v1sid,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: "p", modelID: "m" },
  } as unknown as SessionV1.User,
  parts: [{ ...v1partBase(value, `${value}p`), type: "text", text: "prompt" }] as SessionV1.Part[],
})

const v1assistant = (value: string, parts: SessionV1.Part[]): SessionV1.WithParts => ({
  info: {
    id: `msg_${value}`,
    sessionID: v1sid,
    role: "assistant",
    time: { created: 0, completed: 0 },
    parentID: "msg_parent",
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Assistant,
  parts,
})

const v1tool = (args: {
  id: string
  tool: string
  output: string
  input?: Record<string, unknown>
  status?: string
  metadata?: Record<string, unknown>
}): SessionV1.Part =>
  ({
    ...v1partBase("a", args.id),
    type: "tool",
    callID: args.id,
    tool: args.tool,
    state:
      args.status === "error"
        ? { status: "error", input: args.input ?? {}, error: "boom", time: { start: 0, end: 1 } }
        : {
            status: "completed",
            input: args.input ?? {},
            output: args.output,
            title: args.tool,
            metadata: {},
            time: { start: 0, end: 1 },
          },
    ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
  }) as unknown as SessionV1.Part

const v1toolText = (message: SessionV1.WithParts, index = 0) => {
  const part = message.parts[index]
  if (part === undefined || part.type !== "tool" || part.state.status !== "completed")
    throw new Error("expected completed tool")
  return part.state.output
}

const compactV1 = (messages: readonly SessionV1.WithParts[], overrides?: Partial<MemoryContext.Options>) =>
  MemoryContext.projectV1(messages, { enabled: true, minOutputChars: 100, keepRecentUserTurns: 1, ...overrides })

describe("MemoryContext.projectV1", () => {
  test("disabled flag returns identical array", () => {
    const messages = [v1user("u1"), v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big() })])]
    expect(MemoryContext.projectV1(messages, { enabled: false })).toBe(messages)
  })

  test("compacts old V1 tool output into retrieval marker", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big(), input: { command: "npm test" } })]),
      v1user("u2"),
    ]
    const marker = v1toolText(compactV1(messages)[1]!)
    expect(marker).toContain("[mem:compacted tool result]")
    expect(marker).toContain("kind=bash")
    expect(marker).toContain("call_id=call_1")
    expect(marker).toContain("command=npm test")
    expect(marker).toContain("retrieve=get_tool_call_details")
    expect(marker.length).toBeLessThan(1000)
  })

  test("keeps V1 originals untouched", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big() })]),
      v1user("u2"),
    ]
    const before = v1toolText(messages[1]!)
    compactV1(messages)
    expect(v1toolText(messages[1]!)).toBe(before)
  })

  test("never compacts the protected recent V1 turn", () => {
    const messages = [v1user("u1"), v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big() })])]
    expect(v1toolText(compactV1(messages)[1]!)).toBe(big())
  })

  test("does not compact failed V1 tool results", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_err", tool: "bash", output: big(), status: "error" })]),
      v1user("u2"),
    ]
    const part = compactV1(messages)[1]!.parts[0]!
    if (part.type !== "tool" || part.state.status !== "error") throw new Error("expected error tool")
    expect(part.state.error).toBe("boom")
  })

  test("does not compact provider-executed V1 tools", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [
        v1tool({ id: "call_pe", tool: "bash", output: big(), metadata: { providerExecuted: true } }),
      ]),
      v1user("u2"),
    ]
    expect(v1toolText(compactV1(messages)[1]!)).toBe(big())
  })

  test("does not compact memory tools in V1", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_m", tool: "get_tool_call_details", output: big() })]),
      v1user("u2"),
    ]
    expect(v1toolText(compactV1(messages)[1]!)).toBe(big())
  })

  test("does not recompact already compacted V1 outputs", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_c", tool: "bash", output: "[Old tool result content cleared]" })]),
      v1user("u2"),
    ]
    expect(v1toolText(compactV1(messages)[1]!)).toBe("[Old tool result content cleared]")
  })

  test("respects minOutputChars in V1", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_s", tool: "bash", output: "short" })]),
      v1user("u2"),
    ]
    expect(v1toolText(compactV1(messages, { minOutputChars: 2000 })[1]!)).toBe("short")
  })

  test("detects url and artifact kinds in V1", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [
        v1tool({ id: "call_u", tool: "webfetch", output: big(), input: { url: "https://example.com" } }),
      ]),
      v1assistant("a2", [v1tool({ id: "call_j", tool: "read", output: big(), input: { path: "docs/report.json" } })]),
      v1user("u2"),
    ]
    const projected = compactV1(messages)
    expect(v1toolText(projected[1]!)).toContain("kind=url")
    expect(v1toolText(projected[1]!)).toContain("url=https://example.com")
    expect(v1toolText(projected[2]!)).toContain("kind=artifact")
    expect(v1toolText(projected[2]!)).toContain("path=docs/report.json")
  })

  test("tags PII in V1 markers", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [
        v1tool({ id: "call_p", tool: "bash", output: `${big()} contact vova@example.com card 4111 1111 1111 1111` }),
      ]),
      v1user("u2"),
    ]
    const marker = v1toolText(compactV1(messages)[1]!)
    expect(marker).toContain("pii=email,credit_card")
    expect(marker).toContain("retrieve=get_tool_call_details")
  })

  test("redacts API keys in V1 markers", () => {
    const secret = "sk-proj-abcdef1234567890ABCDEF"
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_r", tool: "bash", output: `${big()} key ${secret}` })]),
      v1user("u2"),
    ]
    const marker = v1toolText(compactV1(messages)[1]!)
    expect(marker).not.toContain(secret)
    expect(marker).toContain("[REDACTED:api_key]")
    expect(marker).toContain("pii=api_key")
    expect(marker).toContain("retrieve=get_tool_call_details")
  })
})
