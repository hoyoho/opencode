import * as Tool from "./tool"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID, parseSessionID } from "../session/schema"
import { SessionStatus } from "../session/status"
import { isRoom, roomOf } from "../session/collaboration"
import { RoomDelivery } from "../session/room-delivery"
import { deliver, wake } from "./wake"
import type { TaskPromptOps } from "./task"
import { Effect, Schema, Scope } from "effect"

export { isRoom, roomOf } from "../session/collaboration"

const id = "room"

// Max unread room entries delivered to a member in a single sync.
const DELIVERY_BATCH_MAX = 100
// Max transcript messages a single `read` returns.
const READ_MAX = 1000

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "create",
    "join",
    "leave",
    "invite",
    "kick",
    "post",
    "read",
    "status",
    "close",
    "open",
    "destroy",
  ]),
  room_id: Schema.optional(Schema.String).annotate({
    description:
      "The room session id. Required for join; optional for read, status, close, open, and post (to name a room this session is no longer a member of, such as one it destroyed).",
  }),
  session_id: Schema.optional(Schema.String).annotate({
    description: "The session id to invite or kick when action=invite or action=kick.",
  }),
  title: Schema.optional(Schema.String).annotate({ description: "Title when creating a room" }),
  message: Schema.optional(Schema.String).annotate({ description: "The message to append when action=post" }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "read: maximum number of transcript messages to return (default 100, most recent first)",
  }),
  after: Schema.optional(Schema.Number).annotate({
    description:
      "read: return entries with seq greater than this, oldest first. Use the to_seq from a previous read's room_page to walk the whole transcript forward.",
  }),
  before: Schema.optional(Schema.Number).annotate({
    description:
      "read: return the last entries with seq less than this. Omit both before and after to get the most recent entries.",
  }),
  reply_to: Schema.optional(Schema.String).annotate({
    description:
      "post: the msg_... id of any existing entry in the room (a member message or a system event) that this post responds to or supersedes (revision history)",
  }),
  skip_events: Schema.optional(Schema.Boolean).annotate({
    description:
      "read: omit membership/system events and return only member messages. room_page total reflects the filtered set, so it is smaller with skip_events=true.",
  }),
})

export const DESCRIPTION = [
  "Collaborate in a shared room: a session whose transcript every member can read. A session is in at most one room; creating or joining another room leaves the previous one (recorded there as a leave event). Any member is equal: there is no owner. A room with a single member is allowed and does not auto-dissolve, unlike a partnership.",
  "create starts a room and joins you; destroy soft-deletes the room: it clears every member and archives the room, keeping the transcript readable by id but no longer writable or joinable; join enters an existing room; leave exits; invite adds another session by id; kick removes another member by id (the kicked event records the actor in a by attr, and a kicked session can be invited back later); close stops further posts and open resumes them; post appends a message to the shared transcript; read returns the transcript (bounded by limit); status returns the room state, members, and delivery ledger.",
  "read is paged by seq so the full history stays reachable: omit before and after for the most recent entries, pass after=<seq> to walk forward from a known point, or before=<seq> to walk backward. Every read emits a room_page line before the body (so it survives truncation) carrying from_seq, to_seq, returned, total, has_older, and has_newer; an empty window still emits it, so a finished read is distinguishable from an empty room.",
  "Each transcript entry carries a message_id attr and each post returns the appended message id and a monotonic append sequence; post accepts reply_to=<message_id> to link a revision, and rejects a reply_to that does not name an existing entry in the room. Equal content is still appended separately.",
  "Delivery is asynchronous: a posted message is appended to the shared transcript and also delivered to each member's session. An idle member is woken to process it in its next turn; a busy member sees it when its current turn ends. Posting never blocks and never interrupts a running turn. Delivery is claimed atomically, so a message is delivered to a member at most once.",
  "Do not post only to acknowledge; post only when you have concrete content to add.",
].join(" ")

const now = () => new Date().toISOString()

const seqOf = (text: string): number | undefined => {
  const match = text.match(/\bseq="(\d+)"/)
  return match ? Number(match[1]) : undefined
}

const renderMessage = (
  room: SessionID,
  sender: Session.Info,
  kind: "user" | "agent",
  seq: number,
  message: string,
  replyTo?: string,
) =>
  [
    `<room_message room="${room}" from="${kind === "user" ? "user" : sender.id}" seq="${seq}" at="${now()}"${replyTo ? ` reply_to="${replyTo}"` : ""}>`,
    message,
    "</room_message>",
  ].join("\n")

const renderEvent = (
  room: SessionID,
  kind: "created" | "joined" | "left" | "kicked" | "closed" | "opened" | "destroyed",
  subject: Session.Info,
  seq: number,
  actor?: Session.Info,
) => {
  const who = `${subject.id} (${subject.agent ?? "unknown"})`
  const text =
    kind === "kicked"
      ? `Session ${who} was removed from the room by ${actor?.id ?? "unknown"} (${actor?.agent ?? "unknown"}).`
      : kind === "joined" && actor
        ? `Session ${who} was added to the room by ${actor.id} (${actor.agent ?? "unknown"}).`
        : `Session ${who} ${kind} the room.`
  return [
    `<room_event room="${room}" type="${kind}" from="${subject.id}" seq="${seq}" at="${now()}"${actor ? ` by="${actor.id}"` : ""}>`,
    text,
    "</room_event>",
  ].join("\n")
}

const textOf = (message: { parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }> }) =>
  message.parts.flatMap((part) =>
    part.type === "text" && part.text !== undefined && part.synthetic !== true ? [part.text] : [],
  )

// An entry's rendered text is built before its message id exists, so the id
// cannot be baked in at append time. `read` and delivery re-attach it from
// `message.info.id` so a member can address the entry with `reply_to`.
const withMessageID = (text: string, messageID: string) =>
  text.replace(/^(\s*<(?:room_message|room_event)\b)/, (_match, tag: string) => `${tag} message_id="${messageID}"`)

type RoomMetadata = {
  readonly room: SessionID
  readonly members: number
  readonly seq?: number
  readonly messageId?: string
  readonly from?: SessionID
  readonly title?: string
}

export const RoomTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service
    const db = database.db
    yield* RoomDelivery.ensure(db)
    yield* RoomDelivery.ensureSeq(db)

    const run = Effect.fn("RoomTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("RoomTool requires promptOps in ctx.extra"))
      const sender: "user" | "agent" = ctx.extra?.sender === "user" ? "user" : "agent"

      const current = yield* sessions.get(ctx.sessionID)

      // Legacy rooms tracked seq in metadata.room_seq with the message written
      // before the counter, so the counter can trail the transcript. When this
      // room has no atomic counter yet, seed from the max of both; the seed is
      // only read once per room, then the room_seq row is authoritative.
      const legacySeed = Effect.fnUntraced(function* (roomID: SessionID) {
        const room = yield* sessions.get(roomID)
        const meta = typeof room.metadata?.room_seq === "number" ? room.metadata.room_seq : 0
        const messages = yield* sessions.messages({ sessionID: roomID })
        const max = messages.reduce((acc, message) => {
          for (const part of message.parts) {
            if (part.type !== "text" || !part.text) continue
            const seq = seqOf(part.text)
            if (seq !== undefined && seq > acc) acc = seq
          }
          return acc
        }, 0)
        return Math.max(meta, max)
      })

      const append = Effect.fn("RoomTool.append")(function* (roomID: SessionID, build: (seq: number) => string) {
        const established = yield* RoomDelivery.hasSeq(db, roomID)
        if (!established) {
          const seed = yield* legacySeed(roomID)
          const seq = yield* RoomDelivery.nextSeq(db, roomID, seed)
          if (seed > 0) yield* sessions.patchMetadata({ sessionID: roomID, metadata: { room_seq: undefined } })
          const message = yield* ops.prompt({
            sessionID: roomID,
            parts: [{ type: "text", text: build(seq) }],
            noReply: true,
          })
          return { id: String(message.info.id), seq }
        }
        const seq = yield* RoomDelivery.nextSeq(db, roomID)
        const message = yield* ops.prompt({
          sessionID: roomID,
          parts: [{ type: "text", text: build(seq) }],
          noReply: true,
        })
        return { id: String(message.info.id), seq }
      })

      const requireRoom = Effect.fn("RoomTool.requireRoom")(function* (value: string | undefined) {
        const roomID = value ? parseSessionID(value) : undefined
        if (!roomID) return yield* Effect.fail(new Error("A valid room id (ses_...) is required"))
        const room = yield* sessions.get(roomID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!room || !isRoom(room)) return yield* Effect.fail(new Error(`Unknown room: ${roomID}`))
        return room
      })

      const membersOf = (roomID: SessionID) =>
        Effect.gen(function* () {
          return (yield* sessions.list()).filter((item) => !isRoom(item) && roomOf(item) === roomID)
        })

      const sync = Effect.fn("RoomTool.sync")(function* (
        roomID: SessionID,
        exclude?: SessionID,
        doWake = false,
        force = false,
        ignored = false,
      ) {
        const roomMessages = yield* sessions.messages({ sessionID: roomID })
        const entries: { id: string; seq: number; text: string }[] = []
        for (const message of roomMessages) {
          const parts = textOf(message)
          const seq = parts.map(seqOf).find((value): value is number => value !== undefined)
          if (seq === undefined) continue
          entries.push({ id: String(message.info.id), seq, text: parts.join("\n\n") })
        }
        if (entries.length === 0) return
        const members = (yield* sessions.list()).filter(
          (item) => item.id !== exclude && !isRoom(item) && roomOf(item) === roomID,
        )
        const deps = { ops, statuses, sessions, scope, db }
        yield* Effect.forEach(
          members,
          (member) =>
            Effect.gen(function* () {
              // Deliver at most DELIVERY_BATCH_MAX unread entries per sync so a
              // large backlog cannot inject a whole transcript in one turn. The
              // rest stay unclaimed and drain on later posts; a pointer is
              // appended so the member knows history exists.
              const delivered = yield* RoomDelivery.deliveredIds(db, roomID, member.id)
              const unread = entries.filter((entry) => !delivered.has(entry.id))
              const batch = unread.slice(0, DELIVERY_BATCH_MAX)
              const fresh: { id: string; text: string }[] = []
              for (const entry of batch) {
                const won = yield* RoomDelivery.claim(db, roomID, member.id, entry.id, entry.seq)
                if (won) fresh.push(entry)
              }
              if (fresh.length > 0) {
                let text = fresh.map((entry) => withMessageID(entry.text, entry.id)).join("\n\n")
                const pending = unread.length - batch.length
                if (pending > 0)
                  text += `\n\n[${pending} more room ${pending === 1 ? "entry" : "entries"} not shown; run room read to review history]`
                // Admit the batch into the member's session right away, so it is
                // visible as a queued turn; a running turn promotes it at its
                // next boundary instead of hiding it in the delivery queue.
                yield* deliver(deps, member, text, { wake: doWake, force, ignored })
                // The room ledger only tracks the hand-off into the session; the
                // session owns the message from here.
                yield* Effect.forEach(
                  fresh,
                  (entry) => RoomDelivery.markDelivered(db, roomID, member.id, entry.id),
                  { discard: true },
                )
              }
              // Wake even without fresh entries: a member may hold a message
              // admitted by a previous post whose wake was skipped (busy,
              // chain-limited, or lease miss). This post re-arms it.
              if (doWake) yield* wake(deps, member, { force })
            }),
          { concurrency: "unbounded", discard: true },
        )
      })

      // A session is in at most one room. Moving to another room leaves the
      // previous one explicitly, so membership never silently changes.
      const switchAway = Effect.fn("RoomTool.switchAway")(function* (session: Session.Info, nextRoom: SessionID) {
        const previous = roomOf(session)
        if (!previous || previous === nextRoom) return
        yield* sessions.patchMetadata({ sessionID: session.id, metadata: { room: undefined } })
        // Keep the delivery ledger: it acts as a watermark, so a rejoin resumes
        // from the gap instead of replaying the whole transcript.
        yield* append(previous, (seq) => renderEvent(previous, "left", session, seq))
        yield* sync(previous, undefined, false, false, sender === "user")
      })

      const roomState = (room: Session.Info): "open" | "closed" | "destroyed" => {
        const state = room.metadata?.room_state
        return state === "closed" || state === "destroyed" ? state : "open"
      }

      if (params.action === "create") {
        const room = yield* sessions.create({ title: params.title ?? "Room", metadata: { isRoom: true } })
        yield* switchAway(current, room.id)
        const appended = yield* append(room.id, (seq) => renderEvent(room.id, "created", current, seq))
        yield* sessions.patchMetadata({ sessionID: current.id, metadata: { room: room.id } })
        yield* RoomDelivery.claimDelivered(db, room.id, current.id, appended.id, appended.seq)
        yield* sync(room.id, undefined, false, false, sender === "user")
        const metadata: RoomMetadata = { room: room.id, members: 0, seq: appended.seq, messageId: appended.id }
        return {
          title: `Room ${room.id}`,
          metadata,
          output: `<room id="${room.id}" message_id="${appended.id}" seq="${appended.seq}">Room created and joined.</room>`,
        }
      }

      if (params.action === "join") {
        const room = yield* requireRoom(params.room_id)
        if (roomState(room) === "destroyed")
          return yield* Effect.fail(new Error(`Room ${room.id} was destroyed`))
        // Joining the room you are already in is a no-op: appending another
        // `joined` event would duplicate delivery, so mirror `invite`'s guard.
        if (roomOf(current) === room.id) {
          const members = yield* membersOf(room.id)
          const metadata: RoomMetadata = { room: room.id, members: members.length }
          return {
            title: `Already in ${room.id}`,
            metadata,
            output: `<room id="${room.id}">${current.id} is already in the room.</room>`,
          }
        }
        yield* switchAway(current, room.id)
        yield* sessions.patchMetadata({ sessionID: current.id, metadata: { room: room.id } })
        const appended = yield* append(room.id, (seq) => renderEvent(room.id, "joined", current, seq))
        yield* RoomDelivery.claimDelivered(db, room.id, current.id, appended.id, appended.seq)
        yield* sync(room.id, undefined, false, false, sender === "user")
        const members = yield* membersOf(room.id)
        const metadata: RoomMetadata = {
          room: room.id,
          members: members.length,
          seq: appended.seq,
          messageId: appended.id,
        }
        return {
          title: `Joined ${room.id}`,
          metadata,
          output: `<room id="${room.id}" message_id="${appended.id}" seq="${appended.seq}">Joined room.</room>`,
        }
      }

      if (params.action === "invite") {
        const roomID = roomOf(current)
        if (!roomID) return yield* Effect.fail(new Error("You are not in a room"))
        const targetID = params.session_id ? parseSessionID(params.session_id) : undefined
        if (!targetID) return yield* Effect.fail(new Error("room invite requires a session_id"))
        const target = yield* sessions.get(targetID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!target || isRoom(target)) return yield* Effect.fail(new Error(`Unknown session: ${params.session_id}`))
        // Membership is project-scoped (`list()`), so an invite can only target a
        // session in the same project; otherwise it would never be listed.
        if (target.projectID !== current.projectID)
          return yield* Effect.fail(new Error(`Session ${target.id} is not in this project`))
        const members = yield* membersOf(roomID)
        if (roomOf(target) === roomID) {
          const metadata: RoomMetadata = { room: roomID, members: members.length }
          return {
            title: `Already in ${roomID}`,
            metadata,
            output: `<room id="${roomID}">${target.id} is already in the room.</room>`,
          }
        }
        const targetRoom = roomOf(target)
        if (targetRoom && targetRoom !== roomID)
          return yield* Effect.fail(
            new Error(
              `${target.id} is already in room ${targetRoom}; ask it to run room leave, then invite it again`,
            ),
          )
        yield* ctx.ask({
          permission: id,
          patterns: [target.id],
          always: ["*"],
          metadata: { action: "invite", room: roomID, session_id: target.id },
        })
        yield* sessions.patchMetadata({ sessionID: target.id, metadata: { room: roomID } })
        const appended = yield* append(roomID, (seq) => renderEvent(roomID, "joined", target, seq, current))
        yield* RoomDelivery.claimDelivered(db, roomID, target.id, appended.id, appended.seq)
        yield* RoomDelivery.claimDelivered(db, roomID, current.id, appended.id, appended.seq)
        yield* sync(roomID, undefined, false, false, sender === "user")
        const metadata: RoomMetadata = {
          room: roomID,
          members: (yield* membersOf(roomID)).length,
          seq: appended.seq,
          messageId: appended.id,
        }
        return {
          title: `Invited ${target.id}`,
          metadata,
          output: `<room id="${roomID}" message_id="${appended.id}" seq="${appended.seq}">Invited ${target.id}.</room>`,
        }
      }

      if (params.action === "kick") {
        const roomID = roomOf(current)
        if (!roomID) return yield* Effect.fail(new Error("You are not in a room"))
        const targetID = params.session_id ? parseSessionID(params.session_id) : undefined
        if (!targetID) return yield* Effect.fail(new Error("room kick requires a session_id"))
        const target = yield* sessions.get(targetID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!target || isRoom(target)) return yield* Effect.fail(new Error(`Unknown session: ${params.session_id}`))
        if (target.projectID !== current.projectID)
          return yield* Effect.fail(new Error(`Session ${target.id} is not in this project`))
        if (target.id === current.id)
          return yield* Effect.fail(new Error("Cannot kick yourself; use room leave to exit"))
        if (roomOf(target) !== roomID)
          return yield* Effect.fail(new Error(`${target.id} is not in room ${roomID}`))
        yield* ctx.ask({
          permission: id,
          patterns: [target.id],
          always: ["*"],
          metadata: { action: "kick", room: roomID, session_id: target.id },
        })
        yield* sessions.patchMetadata({ sessionID: target.id, metadata: { room: undefined } })
        const appended = yield* append(roomID, (seq) => renderEvent(roomID, "kicked", target, seq, current))
        yield* RoomDelivery.claimDelivered(db, roomID, current.id, appended.id, appended.seq)
        yield* sync(roomID, undefined, false, false, sender === "user")
        const metadata: RoomMetadata = {
          room: roomID,
          members: (yield* membersOf(roomID)).length,
          seq: appended.seq,
          messageId: appended.id,
        }
        return {
          title: `Kicked ${target.id}`,
          metadata,
          output: `<room id="${roomID}" message_id="${appended.id}" seq="${appended.seq}">Removed ${target.id}.</room>`,
        }
      }

      if (params.action === "leave") {
        const roomID = params.room_id ? parseSessionID(params.room_id) : roomOf(current)
        if (!roomID) return yield* Effect.fail(new Error("You are not in a room"))
        const room = yield* requireRoom(roomID)
        // Report the archived room before membership: destroy clears every
        // member, so a later leave would otherwise say "not in a room".
        if (roomState(room) === "destroyed")
          return yield* Effect.fail(new Error(`Room ${roomID} was destroyed`))
        if (roomOf(current) !== roomID)
          return yield* Effect.fail(new Error(`You are not a member of room ${roomID}`))
        yield* sessions.patchMetadata({ sessionID: current.id, metadata: { room: undefined } })
        // The delivery ledger is kept on every exit path; `forget` has no callers.
        const appended = yield* append(roomID, (seq) => renderEvent(roomID, "left", current, seq))
        yield* sync(roomID, undefined, false, false, sender === "user")
        const members = yield* membersOf(roomID)
        const left: RoomMetadata = {
          room: roomID,
          members: members.length,
          seq: appended.seq,
          messageId: appended.id,
        }
        return {
          title: `Left ${roomID}`,
          metadata: left,
          output: `<room id="${roomID}" message_id="${appended.id}" seq="${appended.seq}">Left room.</room>`,
        }
      }

      if (params.action === "post") {
        // Posting from the room session itself is the human speaking: a room has
        // no membership of its own, so it is allowed and identified as "user".
        const self = isRoom(current)
        const roomID = params.room_id ? parseSessionID(params.room_id) : self ? current.id : roomOf(current)
        if (!roomID) return yield* Effect.fail(new Error("You are not in a room"))
        if (!params.message) return yield* Effect.fail(new Error("room post requires a message"))
        if (self && roomID !== current.id)
          return yield* Effect.fail(new Error("A room can only post to itself"))
        const room = yield* sessions.get(roomID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!room || !isRoom(room)) return yield* Effect.fail(new Error(`Unknown room: ${roomID}`))
        const state = roomState(room)
        const author: "user" | "agent" = self ? "user" : sender
        // destroy clears every member, so a post after it has no `roomOf` to
        // match. Report the archived room instead of the generic "not in a room"
        // that would read as "you never joined".
        if (!self && roomOf(current) !== roomID)
          return yield* Effect.fail(
            new Error(
              state === "destroyed" ? `Room ${roomID} was destroyed` : `You are not a member of room ${roomID}`,
            ),
          )
        if (state === "destroyed") return yield* Effect.fail(new Error(`Room ${roomID} was destroyed`))
        if (state === "closed")
          return yield* Effect.fail(new Error(`Room ${roomID} is closed; run room open to resume posting`))
        // A dangling reply_to silently breaks the revision chain and, because
        // entries are the only place ids live, cannot be diagnosed after the
        // fact. Reject a target that is not an existing message in this room.
        if (params.reply_to) {
          const existing = yield* sessions.messages({ sessionID: roomID })
          if (!existing.some((message) => String(message.info.id) === params.reply_to))
            return yield* Effect.fail(
              new Error(`reply_to target not found in room ${roomID}: ${params.reply_to}`),
            )
        }
        const appended = yield* append(roomID, (seq) =>
          renderMessage(roomID, current, author, seq, params.message!, params.reply_to),
        )
        // An agent post is the caller's own content, so settle its own ledger and
        // exclude it from delivery. A user post comes from outside and is
        // delivered to every member including the caller, so don't settle here.
        if (author !== "user")
          yield* RoomDelivery.claimDelivered(db, roomID, current.id, appended.id, appended.seq)
        // A user post is injected from the outside: every member, including
        // whoever invoked it, receives the same from="user" message so the
        // source is not identifiable. An agent post is authored by the calling
        // session, which already has it as the tool result, so it is excluded.
        yield* sync(roomID, author === "user" ? undefined : current.id, true, author === "user")
        const members = yield* membersOf(roomID)
        const metadata: RoomMetadata = {
          room: roomID,
          members: members.length,
          seq: appended.seq,
          messageId: appended.id,
          from: current.id,
          title: room.title,
        }
        return {
          title: `Posted to ${roomID} (seq ${appended.seq})`,
          metadata,
          output: `<room id="${roomID}" message_id="${appended.id}" seq="${appended.seq}" delivery="turn-boundary">Message posted.</room>`,
        }
      }

      if (params.action === "close" || params.action === "open") {
        const roomID = params.room_id ? parseSessionID(params.room_id) : roomOf(current)
        if (!roomID) return yield* Effect.fail(new Error("You are not in a room"))
        const room = yield* requireRoom(roomID)
        // Check state before membership: destroy clears every member, so a
        // post-destroy open/close would otherwise report "not a member".
        if (roomState(room) === "destroyed")
          return yield* Effect.fail(new Error(`Room ${roomID} was destroyed`))
        if (roomOf(current) !== roomID)
          return yield* Effect.fail(new Error(`You are not a member of room ${roomID}`))
        const closed = params.action === "close"
        const appended = yield* append(roomID, (seq) =>
          renderEvent(roomID, closed ? "closed" : "opened", current, seq),
        )
        yield* sessions.patchMetadata({ sessionID: roomID, metadata: { room_state: closed ? "closed" : "open" } })
        yield* RoomDelivery.claimDelivered(db, roomID, current.id, appended.id, appended.seq)
        yield* sync(roomID, current.id, false, false, sender === "user")
        const members = yield* membersOf(roomID)
        const metadata: RoomMetadata = {
          room: roomID,
          members: members.length,
          seq: appended.seq,
          messageId: appended.id,
        }
        return {
          title: `${closed ? "Closed" : "Opened"} ${roomID}`,
          metadata,
          output: `<room id="${roomID}" message_id="${appended.id}" seq="${appended.seq}" state="${closed ? "closed" : "open"}">Room ${closed ? "closed" : "opened"}.</room>`,
        }
      }

      if (params.action === "destroy") {
        const roomID = params.room_id ? parseSessionID(params.room_id) : roomOf(current)
        if (!roomID) return yield* Effect.fail(new Error("You are not in a room"))
        const room = yield* requireRoom(roomID)
        // Report an already-destroyed room before the membership check: destroy
        // clears every member, so a retry would otherwise fail as "not a member".
        if (roomState(room) === "destroyed")
          return yield* Effect.fail(new Error(`Room ${roomID} is already destroyed`))
        if (roomOf(current) !== roomID)
          return yield* Effect.fail(new Error(`You are not a member of room ${roomID}`))
        yield* ctx.ask({
          permission: id,
          patterns: [roomID],
          always: ["*"],
          metadata: { action: "destroy", room: roomID },
        })
        const appended = yield* append(roomID, (seq) => renderEvent(roomID, "destroyed", current, seq, current))
        const members = yield* membersOf(roomID)
        // Clear every member (including the caller) so nobody keeps a dangling
        // room id, then archive the room. The transcript stays readable by id.
        yield* Effect.forEach(
          members,
          (member) => sessions.patchMetadata({ sessionID: member.id, metadata: { room: undefined } }),
          { discard: true },
        )
        yield* sessions.patchMetadata({ sessionID: roomID, metadata: { room_state: "destroyed" } })
        yield* sessions.setArchived({ sessionID: roomID, time: Date.now() })
        const metadata: RoomMetadata = { room: roomID, members: 0, seq: appended.seq, messageId: appended.id }
        return {
          title: `Destroyed ${roomID}`,
          metadata,
          output: `<room id="${roomID}" message_id="${appended.id}" seq="${appended.seq}" state="destroyed">Room destroyed.</room>`,
        }
      }

      const roomID = params.room_id ? parseSessionID(params.room_id) : roomOf(current)
      if (!roomID) return yield* Effect.fail(new Error("You are not in a room"))
      const room = yield* requireRoom(roomID)
      // A destroyed room keeps its transcript for inspection by id even though
      // every member was cleared, so read/status skip the membership gate there.
      if (roomOf(current) !== room.id && roomState(room) !== "destroyed")
        return yield* Effect.fail(new Error(`You are not a member of room ${room.id}`))
      const members = yield* membersOf(room.id)
      const rows = yield* RoomDelivery.ledger(db, room.id)
      const byId = new Map(rows.map((row) => [row.session_id, row]))
      const ledger = members.map((member) => {
        const row = byId.get(member.id)
        const seq = row?.delivered_seq ?? 0
        const at = row?.delivered_at
        return `  <member session="${member.id}" delivered_seq="${seq}"${at ? ` delivered_at="${at}"` : ""}/>`
      })

      if (params.action === "status") {
        const metadata: RoomMetadata = { room: room.id, members: members.length }
        return {
          title: `Status ${room.id}`,
          metadata,
          output: [
            `<room id="${room.id}" state="${roomState(room)}" members="${members.length}">`,
            "<room_members>",
            ...ledger,
            "</room_members>",
            "</room>",
          ].join("\n"),
        }
      }

      const requested = params.limit ?? 100
      // `limit` is bounded to protect the context window and keep output
      // pageable. Out-of-range values still return content, but the output says
      // so rather than clamping silently.
      const invalidLimit = !Number.isFinite(requested) || requested < 1
      const limit = invalidLimit ? 100 : Math.min(requested, READ_MAX)
      const limitNote = invalidLimit
        ? `[limit ${params.limit} is not a positive integer; using default 100]`
        : requested > READ_MAX
          ? `[limit ${requested} exceeds max ${READ_MAX}; using ${READ_MAX}]`
          : undefined
      const after = params.after
      const before = params.before
      const messages = yield* sessions.messages({ sessionID: room.id })
      // Classify by the closing tag, not a substring: a real message may quote
      // "<room_event" in its prose (even at line start) and must not be dropped.
      // Each entry keeps its seq so a member can page the entire transcript.
      const entries = messages.flatMap((message) =>
        textOf(message).map((text) => ({ text: withMessageID(text, String(message.info.id)), seq: seqOf(text) })),
      )
      const kept = params.skip_events
        ? entries.filter((entry) => !entry.text.trimEnd().endsWith("</room_event>"))
        : entries

      // `after` walks forward from a known seq (oldest first) so a member can
      // drain the whole transcript; `before` walks backward. Omitting both keeps
      // the most recent `limit` entries. Entries with an unparseable seq cannot
      // be addressed by a cursor, so they only appear in the default window.
      const eligible =
        after !== undefined
          ? kept.filter((entry) => entry.seq !== undefined && entry.seq > after)
          : before !== undefined
            ? kept.filter((entry) => entry.seq !== undefined && entry.seq < before)
            : kept
      const limited = after !== undefined ? eligible.slice(0, limit) : eligible.slice(-limit)
      const truncated = eligible.length > limited.length
      const first = limited[0]?.seq
      const last = limited[limited.length - 1]?.seq
      // An empty window must still describe the whole transcript relative to the
      // requested cursor; deriving the flags only from the returned entries would
      // report has_older/has_newer = false and hide that entries exist.
      const hasOlder =
        first !== undefined
          ? kept.some((entry) => entry.seq !== undefined && entry.seq < first)
          : after !== undefined
            ? kept.some((entry) => entry.seq !== undefined && entry.seq <= after)
            : false
      const hasNewer =
        last !== undefined
          ? kept.some((entry) => entry.seq !== undefined && entry.seq > last)
          : before !== undefined
            ? kept.some((entry) => entry.seq !== undefined && entry.seq >= before)
            : false
      const note =
        after !== undefined
          ? truncated
            ? `[showing the first ${limited.length} of ${eligible.length} entries after seq ${after}; continue with after="${last ?? after}"]`
            : undefined
          : before !== undefined
            ? truncated
              ? `[showing the last ${limited.length} of ${eligible.length} entries before seq ${before}; continue with before="${first ?? before}"]`
              : undefined
            : truncated
              ? `[showing the last ${limited.length} of ${kept.length} room text lines; raise limit (max ${READ_MAX}) to see more]`
              : undefined
      const empty =
        kept.length === 0 && messages.length > 0
          ? `[no displayable room content: ${messages.length} ${messages.length === 1 ? "entry" : "entries"}${params.skip_events ? ", all filtered by skip_events" : ", none with visible text"}]`
          : undefined
      // Always emit the page cursor, even for an empty window: a caller must be
      // able to tell "finished" from "empty room" from "bad args" without
      // guessing, and the default window must still advertise `total`. When the
      // window is empty the boundary collapses onto the requested cursor (or 0).
      const boundary = after ?? before ?? 0
      const cursor = `<room_page from_seq="${first ?? boundary}" to_seq="${last ?? boundary}" returned="${limited.length}" total="${kept.length}" has_older="${hasOlder}" has_newer="${hasNewer}"/>`
      const metadata: RoomMetadata = { room: room.id, members: members.length }
      return {
        title: `Read ${room.id}`,
        metadata,
        output: [
          `<room id="${room.id}">`,
          ...(limitNote ? [limitNote] : []),
          ...(note ? [note] : []),
          ...(empty ? [empty] : []),
          cursor,
          ...limited.map((entry) => entry.text),
          "</room>",
        ].join("\n"),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
