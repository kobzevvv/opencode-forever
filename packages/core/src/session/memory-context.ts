export * as MemoryContext from "./memory-context"

import { Flag } from "../flag/flag"
import { PII } from "./pii"
import { SessionMessage } from "./message"

export type Kind = "bash" | "url" | "artifact" | "generic"

export type Options = {
  readonly sessionID?: string
  readonly enabled?: boolean
  readonly minOutputChars?: number
  readonly keepRecentUserTurns?: number
}

const DEFAULT_MIN_OUTPUT_CHARS = 2000
const DEFAULT_KEEP_RECENT_USER_TURNS = 2
const PREVIEW_HEAD = 400
const PREVIEW_TAIL = 200
const SUMMARY_LIMIT = 200

const MEMORY_TOOL_PATTERN = /(operational_memory|get_tool_call_|find_tool_calls|find_agent_artifact)/

const serializeContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const inputString = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

const detectKind = (name: string, input: Record<string, unknown>, text: string): Kind => {
  if (name === "bash") return "bash"
  if (name === "webfetch" || name === "websearch") return "url"
  const path = inputString(input, "path") ?? inputString(input, "file_path") ?? inputString(input, "filePath")
  if (path !== undefined && /\.(md|json|xml|html|ya?ml|csv)$/.test(path)) return "artifact"
  if (/^https?:\/\/\S+$/.test(text.trim())) return "url"
  return "generic"
}

const kindSummary = (kind: Kind, input: Record<string, unknown>) => {
  if (kind === "bash") {
    const command = inputString(input, "command")
    if (command !== undefined) return `command=${command.slice(0, SUMMARY_LIMIT)}`
  }
  if (kind === "url") {
    const url = inputString(input, "url")
    if (url !== undefined) return `url=${url.slice(0, SUMMARY_LIMIT)}`
  }
  if (kind === "artifact") {
    const path = inputString(input, "path") ?? inputString(input, "file_path") ?? inputString(input, "filePath")
    if (path !== undefined) return `path=${path.slice(0, SUMMARY_LIMIT)}`
  }
  return undefined
}

const preview = (text: string) =>
  text.length <= PREVIEW_HEAD + PREVIEW_TAIL + 16 ? text : `${text.slice(0, PREVIEW_HEAD)}\n...\n${text.slice(-PREVIEW_TAIL)}`

type MarkerArgs = {
  readonly kind: Kind
  readonly name: string
  readonly callID: string
  readonly messageID: string
  readonly sessionID?: string
  readonly text: string
  readonly summary?: string
  readonly outputPaths?: readonly string[]
  readonly pii?: string
}

const toolMarker = (args: MarkerArgs) =>
  [
    "[mem:compacted tool result]",
    `kind=${args.kind} tool=${args.name} call_id=${args.callID} status=success`,
    args.summary,
    args.pii,
    `preview=${preview(args.text)}`,
    args.outputPaths && args.outputPaths.length > 0
      ? `output_paths=${args.outputPaths.slice(0, 5).join(",")}`
      : undefined,
    `original=session ${args.sessionID ?? "?"} message ${args.messageID} (full text kept in SQLite history)`,
    `retrieve=get_tool_call_details(call_id="${args.callID}")`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

type ShellArgs = {
  readonly command: string
  readonly callID: string
  readonly messageID: string
  readonly sessionID?: string
  readonly text: string
  readonly pii?: string
}

const shellMarker = (args: ShellArgs) =>
  [
    "[mem:compacted shell output]",
    `command=${args.command.slice(0, SUMMARY_LIMIT)}`,
    `call_id=${args.callID} status=success`,
    args.pii,
    `preview=${preview(args.text)}`,
    `original=session ${args.sessionID ?? "?"} message ${args.messageID} (full output kept in SQLite history)`,
    `retrieve=get_tool_call_details(call_id="${args.callID}")`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

export const project = (
  messages: readonly SessionMessage.Message[],
  options: Options = {},
): readonly SessionMessage.Message[] => {
  const enabled = options.enabled ?? Flag.OPENCODE_MEMORY_CONTEXT
  if (!enabled) return messages
  const minChars = options.minOutputChars ?? DEFAULT_MIN_OUTPUT_CHARS
  const keepTurns = options.keepRecentUserTurns ?? DEFAULT_KEEP_RECENT_USER_TURNS

  const userIndices: number[] = []
  messages.forEach((message, index) => {
    if (message.type === "user") userIndices.push(index)
  })
  if (userIndices.length === 0) return messages
  const protectedFrom =
    userIndices.length > keepTurns ? userIndices[userIndices.length - keepTurns]! : userIndices[0]!
  if (protectedFrom <= 0) return messages

  let compacted = 0
  const projected = messages.map((message, index) => {
    if (index >= protectedFrom) return message
    if (message.type === "shell") {
      // Without a callID the original cannot be retrieved later, so keep the output intact.
      if (message.output.length < minChars || message.callID === "") return message
      compacted++
      const pii = PII.tag(message.output)
      return {
        ...message,
        output: shellMarker({
          command: message.command,
          callID: message.callID,
          messageID: message.id,
          ...(options.sessionID === undefined ? {} : { sessionID: options.sessionID }),
          text: message.output,
          ...(pii === undefined ? {} : { pii }),
        }),
      }
    }
    if (message.type !== "assistant") return message
    let changed = false
    const content = message.content.map((item) => {
      if (item.type !== "tool") return item
      if (item.state.status !== "completed") return item
      if (item.provider?.executed === true) return item
      if (MEMORY_TOOL_PATTERN.test(item.name)) return item
      const text = serializeContent(item.state.content)
      if (text.length < minChars) return item
      const kind = detectKind(item.name, item.state.input, text)
      const pii = PII.tag(text)
      changed = true
      compacted++
      return {
        ...item,
        state: {
          ...item.state,
          content: [
            {
              type: "text" as const,
              text: toolMarker({
                kind,
                name: item.name,
                callID: item.id,
                messageID: message.id,
                ...(options.sessionID === undefined ? {} : { sessionID: options.sessionID }),
                text,
                ...(kindSummary(kind, item.state.input) === undefined
                  ? {}
                  : { summary: kindSummary(kind, item.state.input)! }),
                ...(item.state.outputPaths === undefined ? {} : { outputPaths: item.state.outputPaths }),
                ...(pii === undefined ? {} : { pii }),
              }),
            },
          ],
        },
      }
    })
    return changed ? { ...message, content } : message
  })

  if (compacted > 0 && Flag.OPENCODE_MEMORY_CONTEXT_DEBUG)
    console.log(
      `[mem-context] session=${options.sessionID ?? "?"} compacted=${compacted} protected_from=${protectedFrom}`,
    )
  return projected
}
