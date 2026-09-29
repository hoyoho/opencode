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

// Free-text remainder: drop the leading subcommand/id tokens, then normalize
// through `tokenize` so surrounding quotes are removed from the payload.
const rest = (input: string, count: number) => tokenize(stripTokens(input.trim(), count)).join(" ")

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
    case "post": {
      const message = rest(args, 1)
      if (!message) return { error: "Usage: /roommgr post <message>" }
      return { tool: "room", params: { action: "post", message } }
    }
    case "read": {
      const tokens = tokenize(stripTokens(args.trim(), 1))
      const roomID = tokens.find((token) => token.startsWith("ses_"))
      const limitToken = tokens.find((token) => /^\d+$/.test(token))
      const afterToken = tokens.find((token) => /^after=\d+$/.test(token))
      const beforeToken = tokens.find((token) => /^before=\d+$/.test(token))
      const skipEvents = tokens.includes("skip_events")
      const limit = limitToken ? Number(limitToken) : undefined
      return {
        tool: "room",
        params: {
          action: "read",
          ...(roomID ? { room_id: roomID } : {}),
          ...(limit ? { limit } : {}),
          ...(afterToken ? { after: Number(afterToken.slice("after=".length)) } : {}),
          ...(beforeToken ? { before: Number(beforeToken.slice("before=".length)) } : {}),
          ...(skipEvents ? { skip_events: true } : {}),
        },
      }
    }
    case "status": {
      const [roomID] = tokenize(stripTokens(args.trim(), 1))
      return { tool: "room", params: { action: "status", ...(roomID ? { room_id: roomID } : {}) } }
    }
    default:
      return {
        error: [
          `Unknown roommgr subcommand: ${sub ?? "(none)"}.`,
          "/roommgr create [title] | destroy [room-id] | join <room-id> | leave | invite <session-id> | kick <session-id> | close [room-id] | open [room-id] | post <message> | read [room-id] [limit] [after=<seq>] [before=<seq>] [skip_events] | status [room-id]",
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
    case "broadcast": {
      const message = rest(args, 1)
      if (!message) return { error: "Usage: /partnermgr broadcast <message>" }
      return { tool: "partner", params: { action: "broadcast", message } }
    }
    case "talk": {
      const [sessionID] = tokenize(stripTokens(args.trim(), 1))
      if (!sessionID) return { error: "Usage: /partnermgr talk <session-id> <message>" }
      const message = rest(args, 2)
      if (!message) return { error: "Usage: /partnermgr talk <session-id> <message>" }
      return { tool: "partner", params: { action: "talk", session_id: sessionID, message } }
    }
    case "status":
      return { tool: "partner", params: { action: "status" } }
    default:
      return {
        error: [
          `Unknown partnermgr subcommand: ${sub ?? "(none)"}.`,
          "/partnermgr add <session-id> | remove <session-id> | broadcast <message> | talk <session-id> <message> | status",
        ].join("\n"),
      }
  }
}
