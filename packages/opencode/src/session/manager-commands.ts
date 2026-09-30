import { Command } from "../command"

export type ManagerInvocation =
  | { readonly tool: "room"; readonly params: Record<string, unknown> }
  | { readonly tool: "partner"; readonly params: Record<string, unknown> }
  | { readonly error: string }

const tokenize = (input: string) =>
  (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ""))

/** Removes the first `count` whitespace-separated tokens, preserving the remainder verbatim. */
const stripTokens = (input: string, count: number) => {
  const re = /"[^"]*"|'[^']*'|\S+/g
  let index = 0
  let seen = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(input)) && seen < count) {
    seen += 1
    index = re.lastIndex
  }
  return input.slice(index).trim()
}

// Free-text remainder: drop the leading subcommand/id tokens, then keep the
// rest verbatim (internal spaces, newlines, and quotes are preserved) so code,
// JSON, and multi-line messages reach the transcript unchanged. A single pair
// of wrapping quotes around the whole remainder is stripped, matching the
// shell-like expectation for `/roommgr say "text with spaces"`.
const rest = (input: string, count: number) => {
  let value = input.trim()
  for (let index = 0; index < count; index++) value = value.replace(/^\S+\s*/, "")
  value = value.trim()
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0])
    return value.slice(1, -1)
  return value
}

/**
 * Parses a `/roommgr` or `/partnermgr` argument string into a direct tool call.
 * Returns `undefined` when the command is not a manager command.
 */
export function parseManagerCommand(command: string, args: string): ManagerInvocation | undefined {
  if (command === Command.Default.ROOMMGR) return parseRoomManager(args)
  if (command === Command.Default.PARTNERMGR) return parsePartnerManager(args)
  return undefined
}

function parseRoomManager(args: string): ManagerInvocation {
  const [sub] = tokenize(args)
  switch (sub) {
    case "new":
    case "create": {
      const title = rest(args, 1)
      return { tool: "room", params: { action: "create", ...(title ? { title } : {}) } }
    }
    case "join": {
      const [roomID] = tokenize(stripTokens(args.trim(), 1))
      if (!roomID) return { error: "Missing argument. Usage: /roommgr join <room-id>" }
      return { tool: "room", params: { action: "join", room_id: roomID } }
    }
    case "leave":
      return { tool: "room", params: { action: "leave" } }
    case "invite": {
      const [sessionID] = tokenize(stripTokens(args.trim(), 1))
      if (!sessionID) return { error: "Usage: /roommgr invite <session-id>" }
      return { tool: "room", params: { action: "invite", session_id: sessionID } }
    }
    case "kick": {
      const [sessionID] = tokenize(stripTokens(args.trim(), 1))
      if (!sessionID) return { error: "Usage: /roommgr kick <session-id>" }
      return { tool: "room", params: { action: "kick", session_id: sessionID } }
    }
    case "close":
    case "open": {
      const [roomID] = tokenize(stripTokens(args.trim(), 1))
      return { tool: "room", params: { action: sub, ...(roomID ? { room_id: roomID } : {}) } }
    }
    case "destroy": {
      const [roomID] = tokenize(stripTokens(args.trim(), 1))
      return { tool: "room", params: { action: "destroy", ...(roomID ? { room_id: roomID } : {}) } }
    }
    case "say":
    case "post": {
      const message = rest(args, 1)
      if (!message) return { error: "Usage: /roommgr say <message>" }
      return { tool: "room", params: { action: "post", message } }
    }
    case "status": {
      const [roomID] = tokenize(stripTokens(args.trim(), 1))
      return { tool: "room", params: { action: "status", ...(roomID ? { room_id: roomID } : {}) } }
    }
    default:
      return {
        error: [
          `Unknown roommgr subcommand: ${sub ?? "(none)"}.`,
          "/roommgr new [title] | join <room-id> | leave | invite <session-id> | kick <session-id> | close [room-id] | open [room-id] | destroy [room-id] | say <message> | status [room-id]",
        ].join("\n"),
      }
  }
}

function parsePartnerManager(args: string): ManagerInvocation {
  const [sub] = tokenize(args)
  switch (sub) {
    case "add":
    case "remove": {
      const [sessionID] = tokenize(stripTokens(args.trim(), 1))
      if (!sessionID) return { error: `Usage: /partnermgr ${sub} <session-id>` }
      return { tool: "partner", params: { action: sub, session_id: sessionID } }
    }
    case "leave":
      return { tool: "partner", params: { action: "leave" } }
    case "broadcast": {
      const message = rest(args, 1)
      if (!message) return { error: "Usage: /partnermgr broadcast <message>" }
      return { tool: "partner", params: { action: "broadcast", message } }
    }
    case "status":
      return { tool: "partner", params: { action: "status" } }
    default:
      return {
        error: [
          `Unknown partnermgr subcommand: ${sub ?? "(none)"}.`,
          "/partnermgr add <session-id> | remove <session-id> | leave | broadcast <message> | status",
        ].join("\n"),
      }
  }
}
