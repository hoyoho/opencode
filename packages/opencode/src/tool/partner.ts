import * as Tool from "./tool"
import { Database } from "@opencode-ai/core/database/database"
import { Session } from "@/session/session"
import { parseSessionID } from "../session/schema"
import { isRoom, partnershipOf, relation } from "../session/collaboration"
import { SessionStatus } from "../session/status"
import { deliver } from "./wake"
import type { TaskPromptOps } from "./task"
import { Effect, Schema, Scope } from "effect"

const id = "partner"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["add", "remove", "leave", "broadcast", "talk", "status"])).annotate({
    description:
      "add adopts a session (default), remove detaches a session, leave detaches yourself, broadcast messages every partner, talk messages one related agent, status lists your partnership",
  }),
  session_id: Schema.optional(Schema.String).annotate({
    description: "The session id to adopt, remove, or message (talk). Omit for leave, broadcast, and status.",
  }),
  message: Schema.optional(Schema.String).annotate({
    description: "The message to deliver when action=talk or action=broadcast.",
  }),
})

export const DESCRIPTION = [
  "Manage your partnership and message related agents. A session is in at most one partnership; joining a session that is already in another partnership fails instead of silently merging groups.",
  "action=add adopts a session as a partner; action=remove detaches a session (it requires a session id; use action=leave to remove yourself); action=leave removes yourself. Joining and leaving notify every partner, and a partnership that drops to a single member is dissolved automatically. A dissolved partnership id is not reused: adding again later starts a new partnership.",
  "action=talk sends one message to a related agent (parent, child, sibling, or partner) by session id; action=broadcast sends one message to every partner in your partnership. Delivery is asynchronous: each idle target is woken to process the message; you do not wait for replies.",
  "action=status lists your partnership id, the number of other partners (excluding yourself), and their sessions. The trailing text on each member line is that session's current title, not a snapshot from when it joined.",
  "Do not send messages only to acknowledge; send only when you have concrete content.",
].join(" ")

const newPartnershipID = () => `prt-${crypto.randomUUID().slice(0, 8)}`

const now = () => new Date().toISOString()

const renderOutput = (partnership: string, partners: readonly Session.Info[]) =>
  [
    `<partnership id="${partnership}" count="${partners.length}">`,
    partners.length === 0
      ? `Partnership "${partnership}" has no other members yet.`
      : [
          `Partnership "${partnership}" members:`,
          ...partners.map((item) => `  ${item.id} (${item.agent ?? "unknown"}) ${item.title}`),
        ].join("\n"),
    "</partnership>",
  ].join("\n")

type PartnerMetadata = { readonly partners: string | undefined; readonly count: number }

type EventKind = "joined" | "left" | "removed"

const renderEvent = (kind: EventKind, subject: Session.Info, partnership: string, actor: Session.Info) => {
  const who = `${subject.id} (${subject.agent ?? "unknown"})`
  const text =
    kind === "joined"
      ? `Session ${who} joined the partnership "${partnership}".`
      : kind === "left"
        ? `Session ${who} left the partnership "${partnership}".`
        : `Session ${who} was removed from the partnership "${partnership}" by ${actor.id} (${actor.agent ?? "unknown"}).`
  return [
    `<partnership_event type="${kind}" at="${now()}" session="${subject.id}" agent="${subject.agent ?? "unknown"}" partnership="${partnership}">`,
    text,
    "</partnership_event>",
  ].join("\n")
}

export const PartnerTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service
    const db = database.db

    const run = Effect.fn("PartnerTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("PartnerTool requires promptOps in ctx.extra"))
      const sender: "user" | "agent" = ctx.extra?.sender === "user" ? "user" : "agent"

      const current = yield* sessions.get(ctx.sessionID)
      const action = params.action ?? "add"
      const raw = params.session_id
      const requested = raw === undefined ? undefined : parseSessionID(raw)
      const leaving = action === "leave"
      const deps = { ops, statuses, sessions, scope, db }

      // Membership changes are notified to every affected member as a visible
      // message (the model sees the result, not the command that caused it).
      // Notify only: never wake for a state change.
      const notify = (targets: readonly Session.Info[], text: string) =>
        Effect.forEach(targets, (target) => deliver(deps, target, text, { wake: false }), {
          concurrency: "unbounded",
          discard: true,
        })

      const deliverOne = (target: Session.Info, text: string) =>
        Effect.gen(function* () {
          const woke = yield* deliver(deps, target, text, { wake: true, force: sender === "user" })
          return { woke }
        })

      // A one-member partnership is meaningless: once a removal leaves a single
      // member, clear that member's id so it does not stay in a group of one.
      const dissolveIfAlone = (partnership: string, remaining: readonly Session.Info[]) =>
        Effect.gen(function* () {
          const lone = remaining.length === 1 ? remaining[0] : undefined
          if (!lone) return
          yield* sessions.patchMetadata({ sessionID: lone.id, metadata: { partners: undefined } })
          // The last member is now solo: tell it the partnership dissolved.
          yield* deliver(
            deps,
            lone,
            `<partnership_event type="dissolved" at="${now()}" partnership="${partnership}">The partnership was dissolved.</partnership_event>`,
            { wake: false },
          )
        })

      if (action === "status") {
        const partnership = partnershipOf(current)
        if (!partnership) {
          const metadata: PartnerMetadata = { partners: undefined, count: 0 }
          return {
            title: "No partnership",
            metadata,
            output: `<partnership state="none">You are not in a partnership.</partnership>`,
          }
        }
        const partners = (yield* sessions.list()).filter(
          (item) => item.id !== current.id && partnershipOf(item) === partnership,
        )
        const metadata: PartnerMetadata = { partners: partnership, count: partners.length }
        return {
          title: `Partnership ${partnership}`,
          metadata,
          output: renderOutput(partnership, partners),
        }
      }

      if (action === "broadcast") {
        const partnership = partnershipOf(current)
        if (!partnership) return yield* Effect.fail(new Error("You are not in a partnership yet"))
        if (!params.message) return yield* Effect.fail(new Error("partner broadcast requires a message"))
        const members = (yield* sessions.list()).filter((item) => partnershipOf(item) === partnership)
        const partners = members.filter((item) => item.id !== current.id)
        // A user broadcast speaks to the whole partnership with the user's voice,
        // so the invoking session is a recipient too: it receives the same
        // inbound message and is woken to act on it. An agent broadcast comes
        // from the agent itself, which already knows the content, so it is not a
        // recipient.
        const targets = sender === "user" ? members : partners
        if (targets.length === 0) {
          const metadata: PartnerMetadata = { partners: partnership, count: 0 }
          return {
            title: `Broadcast to ${partnership}`,
            metadata,
            output: `<partnership id="${partnership}" count="0">No partners to broadcast to.</partnership>`,
          }
        }
        yield* ctx.ask({
          permission: id,
          patterns: [partnership],
          always: ["*"],
          metadata: { action: "broadcast", partners: partnership, count: partners.length },
        })
        const text = [
          `<broadcast sender="${sender === "user" ? "user" : ctx.sessionID}" at="${now()}">`,
          params.message,
          "</broadcast>",
        ].join("\n")
        yield* Effect.forEach(
          targets,
          (target) =>
            Effect.gen(function* () {
              yield* deliverOne(target, text)
            }),
          { concurrency: "unbounded", discard: true },
        )
        const metadata: PartnerMetadata = { partners: partnership, count: partners.length }
        // A user broadcast leaves the inbound message in the sender's transcript
        // rather than a delivery summary; an agent broadcast keeps the summary.
        return {
          title: `Broadcast to ${partners.length} partners`,
          metadata,
          output:
            sender === "user"
              ? text
              : [
                  `<partnership id="${partnership}" count="${partners.length}">`,
                  `Broadcast delivered to ${partners.length} partners.`,
                  "</partnership>",
                ].join("\n"),
        }
      }

      if (action === "talk") {
        if (raw !== undefined && requested === undefined)
          return yield* Effect.fail(new Error(`Invalid session id: ${raw}`))
        if (requested === undefined) return yield* Effect.fail(new Error("partner talk requires a session_id"))
        if (!params.message) return yield* Effect.fail(new Error("partner talk requires a message"))
        const target = yield* sessions.get(requested).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!target) return yield* Effect.fail(new Error(`Unknown agent session: ${raw}`))
        // Partnership membership is project-scoped (`sessions.list()`), but
        // `get` is not. A target from another project would be adopted yet never
        // appear in the list, leaving a broken one-sided partnership.
        if (target.projectID !== current.projectID)
          return yield* Effect.fail(new Error(`Session ${target.id} is not in this project`))
        const kind = relation(current, target)
        if (!kind) return yield* Effect.fail(new Error(`Session ${target.id} is not a related agent of this session`))
        yield* ctx.ask({
          permission: id,
          patterns: [target.id],
          always: ["*"],
          metadata: { action: "talk", session_id: target.id, relation: kind },
        })
        const text = [
          `<agent_message sender="${sender === "user" ? "user" : ctx.sessionID}" relation="${kind}" at="${now()}">`,
          params.message,
          "</agent_message>",
        ].join("\n")
        const { woke } = yield* deliverOne(target, text)
        const metadata: PartnerMetadata = { partners: partnershipOf(current), count: 1 }
        return {
          title: `Message ${kind}: ${target.title}`,
          metadata,
          output: [
            `<agent_message_result session="${target.id}" relation="${kind}" woke="${woke}" state="delivered">`,
            text,
            "</agent_message_result>",
          ].join("\n"),
        }
      }

      if (leaving) {
        const partnership = partnershipOf(current)
        if (!partnership) return yield* Effect.fail(new Error("You are not in a partnership"))
        // Every member, including the leaver, gets the change event.
        const all = (yield* sessions.list()).filter((item) => partnershipOf(item) === partnership)
        const members = all.filter((item) => item.id !== current.id)
        yield* ctx.ask({
          permission: id,
          patterns: [partnership],
          always: ["*"],
          metadata: { action: "leave", partnership },
        })
        yield* sessions.patchMetadata({ sessionID: current.id, metadata: { partners: undefined } })
        yield* notify(all, renderEvent("left", current, partnership, current))
        const dissolved = members.length === 1
        yield* dissolveIfAlone(partnership, members)
        const metadata: PartnerMetadata = { partners: undefined, count: 0 }
        return {
          title: "Left partnership",
          metadata,
          output: `<partnership id="${partnership}" count="0">You left the partnership "${partnership}".${dissolved ? " The partnership was dissolved." : ""}</partnership>`,
        }
      }

      if (raw !== undefined && requested === undefined)
        return yield* Effect.fail(new Error(`Invalid session id: ${raw}`))
      if (requested === undefined) return yield* Effect.fail(new Error(`partner ${action} requires a session_id`))
      const target = yield* sessions.get(requested).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!target) return yield* Effect.fail(new Error(`Unknown session: ${raw}`))
      // See `talk`: membership is project-scoped, so a cross-project target can
      // never be a functional partner.
      if (target.projectID !== current.projectID)
        return yield* Effect.fail(new Error(`Session ${target.id} is not in this project`))
      // A room is a shared transcript, not an agent: it must never be adopted
      // into a partnership (mirrors `room invite` refusing room targets).
      if (action !== "remove" && isRoom(target))
        return yield* Effect.fail(new Error(`Cannot partner a room session: ${target.id}`))
      if (target.id === current.id)
        return yield* Effect.fail(
          new Error(
            action === "remove" ? "Cannot remove yourself; use partner leave" : "Cannot partner a session with itself",
          ),
        )

      yield* ctx.ask({
        permission: id,
        patterns: [target.id],
        always: ["*"],
        metadata: { session_id: target.id, action },
      })

      if (action === "remove") {
        const partnership = partnershipOf(target)
        if (!partnership) return yield* Effect.fail(new Error(`Session ${target.id} is not in a partnership`))
        // Only a member of the target's partnership may remove that member.
        if (partnershipOf(current) !== partnership)
          return yield* Effect.fail(new Error(`You are not in partnership ${partnership}; cannot remove ${target.id}`))
        yield* sessions.patchMetadata({ sessionID: target.id, metadata: { partners: undefined } })
        const remaining = (yield* sessions.list()).filter(
          (item) => item.id !== target.id && partnershipOf(item) === partnership,
        )
        yield* notify(remaining, renderEvent("left", target, partnership, current))
        yield* notify([target], renderEvent("removed", target, partnership, current))
        const dissolved = remaining.length === 1
        yield* dissolveIfAlone(partnership, remaining)
        const metadata: PartnerMetadata = dissolved
          ? { partners: undefined, count: 0 }
          : { partners: partnership, count: remaining.length }
        return {
          title: `Removed partner ${target.id}`,
          metadata,
          output: dissolved
            ? `<partnership id="${partnership}" count="0">Removed ${target.id}; the partnership was dissolved.</partnership>`
            : renderOutput(partnership, remaining),
        }
      }

      const currentID = partnershipOf(current)
      const targetID = partnershipOf(target)
      if (currentID !== undefined && currentID === targetID) {
        const partners = (yield* sessions.list()).filter(
          (item) => item.id !== current.id && partnershipOf(item) === currentID,
        )
        const metadata: PartnerMetadata = { partners: currentID, count: partners.length }
        return {
          title: `Partnership ${currentID}`,
          metadata,
          output: renderOutput(currentID, partners),
        }
      }
      // A session belongs to at most one partnership. Refuse instead of silently
      // merging two groups, so no member's membership changes without consent.
      if (currentID !== undefined && targetID !== undefined && currentID !== targetID)
        return yield* Effect.fail(
          new Error(`${target.id} is already in partnership ${targetID}; leave it before partnering with this session`),
        )

      const partnership = currentID ?? targetID ?? newPartnershipID()
      // The joiner is the target when the current session already had a group
      // (target joins it); otherwise the current session is the one joining.
      const joining = currentID !== undefined ? target : current
      if (currentID !== partnership)
        yield* sessions.patchMetadata({ sessionID: current.id, metadata: { partners: partnership } })
      if (targetID !== partnership)
        yield* sessions.patchMetadata({ sessionID: target.id, metadata: { partners: partnership } })

      const all = (yield* sessions.list()).filter((item) => partnershipOf(item) === partnership)
      // Notify every member, including the actor and the joiner.
      yield* notify(all, renderEvent("joined", joining, partnership, current))
      const partners = all.filter((item) => item.id !== current.id)
      const metadata: PartnerMetadata = { partners: partnership, count: partners.length }
      return {
        title: `Partnership ${partnership}`,
        metadata,
        output: renderOutput(partnership, partners),
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
