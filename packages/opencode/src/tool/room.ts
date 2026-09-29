import * as Tool from "./tool"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID, parseSessionID } from "../session/schema"
import { SessionStatus } from "../session/status"
import { isRoom, roomOf } from "../session/collaboration"
import { RoomDelivery } from "../session/room-delivery"
import { SessionDelivery } from "../session/delivery"
import { drainDeliveries, wake } from "./wake"
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
    description: "The room session id. Required for join; optional for read, status, close, and open.",
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
    description: "post: the msg_... id this post responds to or supersedes (revision history)",
  }),
  skip_events: Schema.optional(Schema.Boolean).annotate({
    description: "read: omit membership/system events and return only member messages",
  }),
})

export const DESCRIPTION = [
  "Collaborate in a shared room: a session whose transcript every member can read. A session is in at most one room; creating or joining another room leaves the previous one (recorded there as a leave event). Any member is equal: there is no owner.",
  "create starts a room and joins you; join enters an existing room; invite adds another session by id; kick removes another member by id; leave exits; post appends a message to the shared transcript; read returns the transcript (bounded by limit); status returns the room state, members, and delivery ledger; close stops further posts and open resumes them; destroy soft-deletes the room once you are its last member: it archives the room and keeps the transcript readable but no longer writable or joinable.",
  "read is paged by seq so the full history stays reachable: omit before and after for the most recent entries, pass after=<seq> to walk forward from a known point, or before=<seq> to walk backward. Each read reports its from_seq/to_seq in a room_page line placed before the body so it survives truncation.",
  "Delivery is asynchronous: a posted message is appended to the shared transcript and also delivered to each member's session. An idle member is woken to process it in its next turn; a busy member sees it when its current turn ends. Posting never blocks and never interrupts a running turn.",
  "Each post returns the appended message id and a monotonic append sequence; equal content is still appended separately. Delivery is claimed atomically, so a message is delivered to a member at most once.",
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
    `<room_message room="${room}" from="${sender.id}" agent="${sender.agent ?? "unknown"}" sender="${kind}" direction="outbound" seq="${seq}" at="${now()}"${replyTo ? ` reply_to="${replyTo}"` : ""}>`,
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
      : `Session ${who} ${kind} the room.`
  return [
    `<room_event room="${room}" type="${kind}" from="${subject.id}" session="${subject.id}" agent="${subject.agent ?? "unknown"}" seq="${seq}" at="${now()}"${actor ? ` by="${actor.id}"` : ""}>`,
    text,
    "</room_event>",
  ].join("\n")
}

const textOf = (message: { parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }> }) =>
  message.parts.flatMap((part) =>
    part.type === "text" && part.text !== undefined && part.synthetic !== true ? [part.text] : [],
  )

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
                // Re-label direction for the recipient, but only the entry's own
                // opening tag: replace the first occurrence per entry so a post
                // that quotes `direction="outbound"` survives verbatim.
                let text = fresh
                  .map((entry) => entry.text.replace('direction="outbound"', 'direction="inbound"'))
                  .join("\n\n")
                const pending = unread.length - batch.length
                if (pending > 0)
                  text += `\n\n[${pending} more room ${pending === 1 ? "entry" : "entries"} not shown; run room read to review history]`
                // Enqueue rather than prompt directly: drainDeliveries below
                // hands it to the member now if idle, or defers it until the
                // member's turn ends, so a running turn is never interrupted.
                yield* SessionDelivery.enqueue(db, { sessionID: member.id, body: text, wake: doWake, force })
                // The room ledger only tracks the hand-off into the queue; the
                // queue owns the message from here.
                yield* Effect.forEach(
                  fresh,
                  (entry) => RoomDelivery.markDelivered(db, roomID, member.id, entry.id),
                  { discard: true },
                )
              }
              yield* drainDeliveries(deps, member.id)
              // Wake even without fresh entries: a member may hold a message
              // delivered by a previous post whose wake was skipped (busy,
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
        yield* sync(previous)
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
        yield* sync(room.id)
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
        yield* sync(room.id)
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
            new Error(`${target.id} is already in room ${targetRoom}; it must leave before joining this one`),
          )
        yield* ctx.ask({
          permission: id,
          patterns: [target.id],
          always: ["*"],
          metadata: { action: "invite", room: roomID, session_id: target.id },
        })
        yield* sessions.patchMetadata({ sessionID: target.id, metadata: { room: roomID } })
        const appended = yield* append(roomID, (seq) => renderEvent(roomID, "joined", target, seq))
        yield* RoomDelivery.claimDelivered(db, roomID, target.id, appended.id, appended.seq)
        yield* RoomDelivery.claimDelivered(db, roomID, current.id, appended.id, appended.seq)
        yield* sync(roomID)
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
        yield* sync(roomID)
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
        const roomID = roomOf(current)
        if (!roomID) return yield* Effect.fail(new Error("You are not in a room"))
        yield* sessions.patchMetadata({ sessionID: current.id, metadata: { room: undefined } })
        // The delivery ledger is kept on every exit path; `forget` has no callers.
        const appended = yield* append(roomID, (seq) => renderEvent(roomID, "left", current, seq))
        yield* sync(roomID)
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
        const roomID = roomOf(current)
        if (!roomID) return yield* Effect.fail(new Error("You are not in a room"))
        if (!params.message) return yield* Effect.fail(new Error("room post requires a message"))
        const room = yield* sessions.get(roomID)
        const state = roomState(room)
        if (state === "destroyed") return yield* Effect.fail(new Error(`Room ${roomID} was destroyed`))
        if (state === "closed")
          return yield* Effect.fail(new Error(`Room ${roomID} is closed; run room open to resume posting`))
        const appended = yield* append(roomID, (seq) =>
          renderMessage(roomID, current, sender, seq, params.message!, params.reply_to),
        )
        yield* RoomDelivery.claimDelivered(db, roomID, current.id, appended.id, appended.seq)
        yield* sync(roomID, current.id, true, sender === "user")
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
        if (roomOf(current) !== roomID)
          return yield* Effect.fail(new Error(`You are not a member of room ${roomID}`))
        const room = yield* requireRoom(roomID)
        const closed = params.action === "close"
        const appended = yield* append(roomID, (seq) =>
          renderEvent(roomID, closed ? "closed" : "opened", current, seq),
        )
        yield* sessions.patchMetadata({ sessionID: roomID, metadata: { room_state: closed ? "closed" : "open" } })
        yield* RoomDelivery.claimDelivered(db, roomID, current.id, appended.id, appended.seq)
        yield* sync(roomID, current.id, false)
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
        // Destroying a shared room would evict everyone else without consent, so
        // it is only allowed once you are the last member. Others must remove
        // themselves (or be removed) first.
        const others = (yield* membersOf(roomID)).filter((member) => member.id !== current.id)
        if (others.length > 0)
          return yield* Effect.fail(
            new Error(
              `Room ${roomID} still has ${others.length} other ${others.length === 1 ? "member" : "members"}; they must leave before it can be destroyed`,
            ),
          )
        yield* ctx.ask({
          permission: id,
          patterns: [roomID],
          always: ["*"],
          metadata: { action: "destroy", room: roomID },
        })
        const appended = yield* append(roomID, (seq) => renderEvent(roomID, "destroyed", current, seq, current))
        // Only the caller remains: clear them, then archive the room. The
        // transcript stays readable by id.
        yield* sessions.patchMetadata({ sessionID: current.id, metadata: { room: undefined } })
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
      const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, READ_MAX) : 100
      const after = params.after
      const before = params.before
      const messages = yield* sessions.messages({ sessionID: room.id })
      // Classify by the closing tag, not a substring: a real message may quote
      // "<room_event" in its prose (even at line start) and must not be dropped.
      // Each entry keeps its seq so a member can page the entire transcript.
      const entries = messages.flatMap((message) => textOf(message).map((text) => ({ text, seq: seqOf(text) })))
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
      const hasOlder = first !== undefined && kept.some((entry) => entry.seq !== undefined && entry.seq < first)
      const hasNewer = last !== undefined && kept.some((entry) => entry.seq !== undefined && entry.seq > last)
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
      // Cursor for the next page, emitted above the body so it survives tool
      // output truncation, which keeps the head and drops the tail.
      const cursor =
        limited.length > 0 && (hasOlder || hasNewer)
          ? `<room_page from_seq="${first ?? ""}" to_seq="${last ?? ""}" returned="${limited.length}" total="${kept.length}" has_older="${hasOlder}" has_newer="${hasNewer}"/>`
          : undefined
      const metadata: RoomMetadata = { room: room.id, members: members.length }
      return {
        title: `Read ${room.id}`,
        metadata,
        output: [
          `<room id="${room.id}">`,
          ...(note ? [note] : []),
          ...(empty ? [empty] : []),
          ...(cursor ? [cursor] : []),
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
