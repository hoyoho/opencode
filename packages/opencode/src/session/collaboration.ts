import type { Session } from "./session"
import { parseSessionID, type SessionID } from "./schema"

export type Relation = "parent" | "child" | "sibling" | "partner"

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** Reads the shared partnership id a session was adopted into, if any. */
export function partnershipOf(session: Session.Info): string | undefined {
  const id = session.metadata?.partners
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/** Reads the room session id a session belongs to, if any. */
export function roomOf(session: Session.Info): SessionID | undefined {
  const id = session.metadata?.room
  return typeof id === "string" ? parseSessionID(id) : undefined
}

/** Whether a session is itself a room (shared transcript). */
export function isRoom(session: Session.Info): boolean {
  return session.metadata?.isRoom === true
}

/** Returns session metadata with the partnership id removed. */
export function withoutPartnership(
  metadata: Session.Info["metadata"],
): NonNullable<Session.Info["metadata"]> {
  const next = { ...metadata }
  delete next.partners
  return next
}

/**
 * Classifies how one session relates to another. Subagent-family links win over
 * explicit partnership so the roster always shows the closest relationship.
 */
export function relation(current: Session.Info, target: Session.Info): Relation | undefined {
  if (target.id === current.id) return undefined
  if (current.parentID === target.id) return "parent"
  if (target.parentID === current.id) return "child"
  if (current.parentID !== undefined && target.parentID === current.parentID) return "sibling"
  const partnership = partnershipOf(current)
  if (partnership !== undefined && partnershipOf(target) === partnership) return "partner"
  return undefined
}

export interface Participants {
  readonly parent?: Session.Info
  readonly siblings: readonly Session.Info[]
  readonly children: readonly Session.Info[]
  readonly partners: readonly Session.Info[]
  readonly room?: string
}

/**
 * Renders the set of related agent sessions for the system prompt. Returns
 * `undefined` when the session has no relatives so solo sessions stay unchanged.
 */
export function renderRoster(current: Session.Info, participants: Participants): string | undefined {
  const partnership = partnershipOf(current)
  if (
    !participants.parent &&
    participants.siblings.length === 0 &&
    participants.children.length === 0 &&
    participants.partners.length === 0 &&
    !participants.room
  )
    return undefined
  const line = (session: Session.Info, role: Relation | "self") =>
    `  <agent session="${session.id}" agent="${escape(session.agent ?? "unknown")}" role="${role}">${escape(session.title)}</agent>`
  return [
    "<collaborating_agents>",
    "You are one of several agent sessions sharing this workspace. Use the partner tool to message other agents: partner action=talk session_id=... message=... for one related agent, or partner action=broadcast message=... for every partner in your partnership.",
    `You are session "${current.id}" (agent "${escape(current.agent ?? "unknown")}"). This is your own session id; use it when a message asks for your session.`,
    ...(partnership ? [`Your partnership id is "${escape(partnership)}".`] : []),
    ...(participants.room
      ? [
          `You are in room "${escape(participants.room)}". Use the room tool: room action=read to see the shared transcript, room action=status for members and delivery state, room action=post to add to it, and room action=leave to exit.`,
        ]
      : []),
    line(current, "self"),
    ...(participants.parent ? [line(participants.parent, "parent")] : []),
    ...participants.siblings.map((session) => line(session, "sibling")),
    ...participants.children.map((session) => line(session, "child")),
    ...participants.partners.map((session) => line(session, "partner")),
    "</collaborating_agents>",
  ].join("\n")
}
