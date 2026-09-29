import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit, Cause, Scope } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { partnershipOf, relation, renderRoster } from "../../src/session/collaboration"
import { SessionLease } from "../../src/session/lease"
import { sql } from "drizzle-orm"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID, parseSessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { PartnerTool } from "../../src/tool/partner"
import { RoomTool, isRoom, roomOf } from "../../src/tool/room"
import { deliver, drainDeliveries, wake } from "../../src/tool/wake"
import { SessionDelivery } from "../../src/session/delivery"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    Database.node,
    RuntimeFlags.node,
  ]),
)

const it = testEffect(layer)

function assistantReply(sessionID: Session.Info["id"], text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID,
      mode: "general",
      agent: "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function stubOps(
  opts: {
    onPrompt?: (input: SessionPrompt.PromptInput) => void
    onLoop?: (sessionID: Session.Info["id"]) => void
    text?: string
  } = {},
): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts.onPrompt?.(input)
        return assistantReply(input.sessionID, opts.text ?? "done")
      }),
    loop: (sessionID) =>
      Effect.sync(() => {
        opts.onLoop?.(sessionID)
        return assistantReply(sessionID, opts.text ?? "done")
      }),
  }
}

function persistingOps(
  sessions: Session.Interface,
  opts: {
    onPrompt?: (input: SessionPrompt.PromptInput) => void
    onLoop?: (sessionID: Session.Info["id"]) => void
  } = {},
): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        opts.onPrompt?.(input)
        const messageID = MessageID.ascending()
        const info: SessionV1.User = {
          id: messageID,
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: input.agent ?? "build",
          model: { providerID: ref.providerID, modelID: ref.modelID },
        }
        yield* sessions.updateMessage(info)
        for (const part of input.parts) {
          if (part.type !== "text") continue
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID,
            sessionID: input.sessionID,
            type: "text",
            text: part.text,
          } satisfies SessionV1.Part)
        }
        const stored = yield* sessions.messages({ sessionID: input.sessionID, limit: 100 }).pipe(Effect.orDie)
        const found = stored.find((message) => message.info.id === messageID)
        return found ?? assistantReply(input.sessionID, "done")
      }),
    loop: (sessionID) =>
      Effect.sync(() => {
        opts.onLoop?.(sessionID)
        return assistantReply(sessionID, "done")
      }),
  }
}

function context(sessionID: Session.Info["id"], promptOps: TaskPromptOps, extra: Record<string, unknown> = {}) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps, ...extra },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function deliveredSeqOf(output: string, session: string) {
  return new RegExp(`<member session="${session}" delivered_seq="(\\d+)"`).exec(output)?.[1]
}

// `sync` delivers every fresh entry in a *single* prompt, so counting prompts
// would let a full-backlog replay pass as "one more delivery". Count entry
// openings instead.
function roomEntryCount(texts: string[]) {
  return texts.flatMap((text) => text.match(/<room_(?:message|event) /g) ?? []).length
}

function roomEntries(sessions: Session.Interface, sessionID: Session.Info["id"]) {
  return Effect.map(sessions.messages({ sessionID }).pipe(Effect.orDie), (messages) =>
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "text" && part.text && part.text.includes("<room_") ? [part.text] : [],
      ),
    ),
  )
}

function collectTexts(seen: string[]) {
  return (input: SessionPrompt.PromptInput) => {
    const part = input.parts[0]
    if (part?.type === "text") seen.push(part.text)
  }
}

describe("session.collaboration", () => {
  it.instance("classifies parent, child, and sibling relations", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent", agent: "build" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child", agent: "general" })
      const sibling = yield* sessions.create({ parentID: parent.id, title: "Sibling", agent: "explore" })
      const stranger = yield* sessions.create({ title: "Stranger" })

      expect(relation(child, parent)).toBe("parent")
      expect(relation(parent, child)).toBe("child")
      expect(relation(child, sibling)).toBe("sibling")
      expect(relation(child, child)).toBeUndefined()
      expect(relation(parent, stranger)).toBeUndefined()
    }),
    { timeout: 30000 },
  )

  it.instance("renders a roster while omitting solo sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent", agent: "build" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child", agent: "general" })
      const solo = yield* sessions.create({ title: "Solo" })

      expect(renderRoster(solo, { siblings: [], children: [], partners: [] })).toBeUndefined()

      const roster = renderRoster(child, { parent, siblings: [], children: [], partners: [] })
      expect(roster).toContain('role="self"')
      expect(roster).toContain('role="parent"')
      expect(roster).toContain(`session="${parent.id}"`)
      expect(roster).toContain("partner tool")
    }),
    { timeout: 30000 },
  )

  it.instance("relates explicit partners and renders the partnership id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build", metadata: { partners: "crew" } })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build", metadata: { partners: "crew" } })
      const outside = yield* sessions.create({ title: "Outside" })

      expect(partnershipOf(alpha)).toBe("crew")
      expect(partnershipOf(outside)).toBeUndefined()
      expect(relation(alpha, bravo)).toBe("partner")
      expect(relation(alpha, outside)).toBeUndefined()

      const roster = renderRoster(alpha, { siblings: [], children: [], partners: [bravo] })
      expect(roster).toContain(`session="${bravo.id}"`)
      expect(roster).toContain('role="partner"')
      expect(roster).toContain('partnership id is "crew"')
    }),
    { timeout: 30000 },
  )
})

describe("tool.partner", () => {
  it.instance("adopts a session and is transitive across groups", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const charlie = yield* sessions.create({ title: "Charlie", agent: "build" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()

      const first = yield* def.execute({ session_id: bravo.id }, context(alpha.id, stubOps()))
      const partnership = first.metadata.partners
      expect(typeof partnership).toBe("string")
      expect(partnershipOf(yield* sessions.get(alpha.id))).toBe(partnership)
      expect(partnershipOf(yield* sessions.get(bravo.id))).toBe(partnership)

      yield* def.execute({ session_id: charlie.id }, context(bravo.id, stubOps()))

      expect(partnershipOf(yield* sessions.get(charlie.id))).toBe(partnership)
      expect(relation(yield* sessions.get(alpha.id), yield* sessions.get(charlie.id))).toBe("partner")
    }),
    { timeout: 30000 },
  )

  it.instance("refuses to partner across two existing partnerships", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const a = yield* sessions.create({ title: "A", metadata: { partners: "one" } })
      const b = yield* sessions.create({ title: "B", metadata: { partners: "two" } })
      const b2 = yield* sessions.create({ title: "B2", metadata: { partners: "two" } })
      const tool = yield* PartnerTool
      const def = yield* tool.init()

      const exit = yield* def.execute({ session_id: b.id }, context(a.id, stubOps())).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(partnershipOf(yield* sessions.get(a.id))).toBe("one")
      expect(partnershipOf(yield* sessions.get(b.id))).toBe("two")
      expect(partnershipOf(yield* sessions.get(b2.id))).toBe("two")
    }),
    { timeout: 30000 },
  )

  it.instance("tolerates a stray action word in the session_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { session_id: `add ${bravo.id}`, action: "add" },
        context(alpha.id, stubOps()),
      )

      expect(partnershipOf(yield* sessions.get(bravo.id))).toBe(result.metadata.partners)
    }),
    { timeout: 30000 },
  )

  it.instance("broadcasts again when a member rejoins after leaving", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()
      yield* def.execute({ session_id: bravo.id }, context(alpha.id, stubOps()))
      yield* def.execute({ action: "remove", session_id: alpha.id }, context(alpha.id, stubOps()))

      const seen: string[] = []
      yield* def.execute(
        { session_id: bravo.id },
        context(alpha.id, stubOps({ onPrompt: collectTexts(seen) })),
      )

      expect(seen.some((text) => text.includes('type="joined"'))).toBe(true)
      expect(seen.some((text) => text.includes(alpha.id))).toBe(true)
    }),
    { timeout: 30000 },
  )

  it.instance("notifies partners when a new member joins", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()
      const seen: string[] = []

      yield* def.execute(
        { session_id: bravo.id },
        context(alpha.id, stubOps({ onPrompt: collectTexts(seen) })),
      )

      expect(seen.some((text) => text.includes('type="joined"'))).toBe(true)
      // The notification names the joiner (the initiator), not the recipient.
      expect(seen.some((text) => text.includes(alpha.id))).toBe(true)

      const before = seen.length
      yield* def.execute({ session_id: bravo.id }, context(alpha.id, stubOps({ onPrompt: collectTexts(seen) })))
      expect(seen.length).toBe(before)
    }),
    { timeout: 30000 },
  )

  // A two-member partnership is meaningless once one leaves, so it auto-dissolves:
  // the remaining member's id is cleared as well.
  it.instance("leaving a partnership dissolves a two-member group", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()
      yield* def.execute({ session_id: bravo.id }, context(alpha.id, stubOps()))

      const seen: string[] = []
      const result = yield* def.execute(
        { action: "remove", session_id: alpha.id },
        context(alpha.id, stubOps({ onPrompt: collectTexts(seen) })),
      )

      expect(partnershipOf(yield* sessions.get(alpha.id))).toBeUndefined()
      expect(partnershipOf(yield* sessions.get(bravo.id))).toBeUndefined()
      expect(seen.some((text) => text.includes('type="left"'))).toBe(true)
      expect(result.metadata.count).toBe(0)
    }),
    { timeout: 30000 },
  )

  it.instance("does not dissolve a partnership while two or more members remain", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const charlie = yield* sessions.create({ title: "Charlie", agent: "build" })
      const def = yield* (yield* PartnerTool).init()
      yield* def.execute({ session_id: bravo.id }, context(alpha.id, stubOps()))
      yield* def.execute({ session_id: charlie.id }, context(alpha.id, stubOps()))
      const partnership = partnershipOf(yield* sessions.get(bravo.id))

      yield* def.execute({ action: "remove", session_id: alpha.id }, context(alpha.id, stubOps()))

      expect(partnershipOf(yield* sessions.get(bravo.id))).toBe(partnership)
      expect(partnershipOf(yield* sessions.get(charlie.id))).toBe(partnership)
    }),
    { timeout: 30000 },
  )

  it.instance("partner remove requires a session_id; removing yourself detaches", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const def = yield* (yield* PartnerTool).init()
      yield* def.execute({ session_id: bravo.id }, context(alpha.id, stubOps()))

      const noArg = yield* def.execute({ action: "remove" }, context(alpha.id, stubOps())).pipe(Effect.exit)
      expect(Exit.isFailure(noArg)).toBe(true)
      // A refused call leaves membership untouched.
      expect(partnershipOf(yield* sessions.get(alpha.id))).toBeDefined()

      // `remove <your own id>` is the detach path (former `leave`).
      const self = yield* def.execute({ action: "remove", session_id: alpha.id }, context(alpha.id, stubOps()))
      expect(self.title).toContain("Left partnership")
      expect(partnershipOf(yield* sessions.get(alpha.id))).toBeUndefined()
      // The two-member group dissolves, so bravo is cleared as well.
      expect(partnershipOf(yield* sessions.get(bravo.id))).toBeUndefined()
    }),
    { timeout: 30000 },
  )

  it.instance("removing the other member of a two-member partnership dissolves it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const def = yield* (yield* PartnerTool).init()
      yield* def.execute({ session_id: bravo.id }, context(alpha.id, stubOps()))

      const removed = yield* def.execute({ action: "remove", session_id: bravo.id }, context(alpha.id, stubOps()))

      expect(removed.output).toContain("dissolved")
      expect(partnershipOf(yield* sessions.get(alpha.id))).toBeUndefined()
      expect(partnershipOf(yield* sessions.get(bravo.id))).toBeUndefined()
    }),
    { timeout: 30000 },
  )

  // The `left` notification has to survive into the remaining member's own
  // session store, otherwise a member that is idle when its partner leaves only
  // finds out on some later, unrelated turn. Asserted against real persistence
  // (not a stub capture) because `notify` is `noReply`, so nothing else in the
  // system would make the message visible.
  it.instance("delivers the leave notification into the remaining member's session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()
      yield* def.execute({ session_id: bravo.id }, context(alpha.id, persistingOps(sessions)))
      const partnership = partnershipOf(yield* sessions.get(bravo.id))

      yield* def.execute({ action: "remove", session_id: alpha.id }, context(alpha.id, persistingOps(sessions)))

      const stored = yield* sessions.messages({ sessionID: bravo.id }).pipe(Effect.orDie)
      const texts = stored.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])),
      )
      const left = texts.find((text) => text.includes('type="left"'))
      expect(left).toBeDefined()
      expect(left).toContain(alpha.id)
      expect(left).toContain(partnership ?? "")
    }),
    { timeout: 30000 },
  )

  // Membership events notify but deliberately do not wake: a partner leaving
  // must not spend a member's turn or interrupt one in progress. Pinned so a
  // future "wake on notify" is a deliberate diff rather than an accident.
  it.instance("does not wake a member when a partner leaves", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()
      yield* def.execute({ session_id: bravo.id }, context(alpha.id, persistingOps(sessions)))

      const looped: string[] = []
      yield* def.execute(
        { action: "remove", session_id: alpha.id },
        context(alpha.id, persistingOps(sessions, { onLoop: (sessionID) => looped.push(sessionID) })),
      )

      expect(looped).toEqual([])
    }),
    { timeout: 30000 },
  )

  // The membership guards live inside `run`, so the in-process driver reaches
  // them exactly as the live tool did — what it bypasses is the user-typed
  // command path, not the guard. These four refusals were previously verified
  // only by hand (all five live checks in round 2 were manual).
  it.instance("refuses room reads and state changes for a non-member", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const outsider = yield* sessions.create({ title: "Outsider", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const created = yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      const room = created.metadata.room

      const refuse = (
        params: { action: "read" | "status" | "close" | "open"; room_id?: string },
        sessionID: Session.Info["id"],
      ) =>
        def.execute(params, context(sessionID, persistingOps(sessions))).pipe(
          Effect.exit,
          Effect.map((exit) => {
            if (!Exit.isFailure(exit)) throw new Error(`expected refusal for ${JSON.stringify(params)}`)
            return String(Cause.squash(exit.cause))
          }),
        )

      for (const action of ["read", "status", "close", "open"] as const) {
        expect(yield* refuse({ action, room_id: room }, outsider.id)).toContain("not a member")
      }
      // Targeting nothing at all is a different refusal, not a generic reject.
      expect(yield* refuse({ action: "read" }, outsider.id)).toContain("not in a room")

      // The guard must fire before `append`: four refused calls consume no seq,
      // so the next real post is still seq 2 rather than 6.
      const posted = yield* def.execute(
        { action: "post", message: "still seq 2" },
        context(alpha.id, persistingOps(sessions)),
      )
      expect(posted.metadata.seq).toBe(2)

      // Control: the member is not blanket-refused.
      const mine = yield* def.execute({ action: "read" }, context(alpha.id, persistingOps(sessions)))
      expect(mine.output).toContain(room)
    }),
    { timeout: 30000 },
  )

  // `read` bounds with `Number.isFinite(limit) && limit > 0` (room.ts:473), so
  // every non-positive value — `0` and `-5` alike — takes the unbounded branch.
  // A negative limit is the one that matters: it is not a documented escape
  // hatch, so it silently hands a model the entire transcript with no note.
  it.instance("keeps read bounded when the limit is negative", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const created = yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      const room = created.metadata.room

      // Written straight into the room session: this is about what `read` does
      // with the entries it finds, not about the append path.
      for (let index = 0; index < 120; index++) {
        const messageID = MessageID.ascending()
        yield* sessions.updateMessage({
          id: messageID,
          role: "user",
          sessionID: room,
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ref.providerID, modelID: ref.modelID },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID,
          sessionID: room,
          type: "text",
          text: `entry-${index}`,
        })
      }

      const unbounded = yield* def.execute(
        { action: "read", limit: -5 },
        context(alpha.id, persistingOps(sessions)),
      )
      // Bounded, and the reader is told it was bounded: the oldest entry must be
      // dropped rather than inlined, and a note must be present either way.
      expect(unbounded.output).not.toContain("entry-0<")
      expect(unbounded.output).not.toContain("entry-0\n")
      expect(unbounded.output).toContain("[showing the last")
      expect(unbounded.output).not.toContain("limit: 0 returns all")
    }),
    { timeout: 30000 },
  )

  // Every exit path that produces an event for the acting session must settle
  // that session's ledger, or the event comes back to it as an unread delivery.
  // `leave` is legitimately exempt (the leaver is no longer a member); `kick` is
  // not, because the kicker stays in the room.
  it.instance("settles the kicked event in the kicker's own delivery ledger", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      const room = (yield* def.execute({ action: "create" }, context(alpha.id, ops))).metadata.room
      yield* def.execute({ action: "invite", session_id: bravo.id }, context(alpha.id, ops))

      const kicked = yield* def.execute({ action: "kick", session_id: bravo.id }, context(alpha.id, ops))
      const seq = kicked.metadata.seq
      if (!seq) throw new Error(`no seq on ${JSON.stringify(kicked.metadata)}`)

      const status = yield* def.execute({ action: "status", room_id: room }, context(alpha.id, ops))
      expect(Number(deliveredSeqOf(status.output, alpha.id))).toBeGreaterThanOrEqual(seq)
    }),
    { timeout: 30000 },
  )

  // A voluntary `leave` must not delete the leaver's delivery ledger, and a
  // rejoin must therefore not replay history. Pinned through the public surface
  // only: bravo's post gives alpha a real delivered row, then alpha leaves and
  // rejoins. If the removed `forget` ever returns, the rejoin gap becomes the
  // whole backlog and alpha's session grows.
  it.instance("does not replay history to a member that leaves and rejoins", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      const room = (yield* def.execute({ action: "create" }, context(alpha.id, ops))).metadata.room
      yield* def.execute({ action: "invite", session_id: bravo.id }, context(alpha.id, ops))
      yield* def.execute({ action: "post", message: "hello from bravo" }, context(bravo.id, ops))

      const before = yield* def.execute({ action: "status", room_id: room }, context(bravo.id, ops))
      const beforeSeq = Number(deliveredSeqOf(before.output, alpha.id))
      expect(beforeSeq).toBeGreaterThan(0)
      const beforeCount = roomEntryCount(yield* roomEntries(sessions, alpha.id))

      yield* def.execute({ action: "leave" }, context(alpha.id, ops))
      // A departed member is no longer listed, so the watermark is not visible
      // here even though the rows are still on disk. `status` renders the ledger
      // for current members only; widening that join would leak per-member
      // delivery state to a non-member, so the guard is pinned in both directions.
      const during = yield* def.execute({ action: "status", room_id: room }, context(bravo.id, ops))
      expect(during.output).not.toContain(alpha.id)
      expect(deliveredSeqOf(during.output, alpha.id)).toBeUndefined()
      yield* def.execute({ action: "join", room_id: room }, context(alpha.id, ops))

      const after = yield* def.execute({ action: "status", room_id: room }, context(bravo.id, ops))
      // `delivered_seq` is a high-water mark over seq numbers, not a count: it
      // jumps by two because alpha's own `member_left` was never delivered to it
      // (it was not a member at that point) and the rejoin event is seq 5.
      expect(Number(deliveredSeqOf(after.output, alpha.id))).toBe(beforeSeq + 2)

      // The gap is exactly alpha's own `member_left` and nothing else: that event
      // was never settled for it, so it is owed exactly once. A reintroduced
      // `forget` would instead replay the whole backlog here.
      const replayed = yield* roomEntries(sessions, alpha.id)
      expect(roomEntryCount(replayed)).toBe(beforeCount + 1)
      expect(replayed[replayed.length - 1]).toContain('type="left"')

      // Ledger rows, which the session count above cannot see. The leave must
      // not delete any of them, and the rejoin adds exactly two: the gap entry it
      // delivers and its own `joined` event. This is the claim → markDelivered
      // settle path, so a row shortfall here is a settle failure, not a count.
      const database = yield* Database.Service
      const db = database.db
      const rows = yield* db
        .all<{ n: number }>(sql`
          SELECT COUNT(*) AS n FROM room_delivery_msg WHERE room_id = ${room} AND session_id = ${alpha.id}
        `)
        .pipe(Effect.orDie)
      expect(Number(rows[0]?.n)).toBe(5)
    }),
    { timeout: 30000 },
  )

  // The other shape of the same path: a member that joins an *established* room
  // starts at watermark 0, so its first join legitimately receives the whole
  // backlog — that is delivery, not replay. The rejoin afterwards must still get
  // only its own unsettled `member_left`. The test above cannot see this because
  // alpha is present from creation, so both shapes need pinning separately.
  it.instance("delivers the backlog once to a member that joins an established room", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      const room = (yield* def.execute({ action: "create" }, context(alpha.id, ops))).metadata.room
      yield* def.execute({ action: "post", message: "one" }, context(alpha.id, ops))
      yield* def.execute({ action: "post", message: "two" }, context(alpha.id, ops))

      yield* def.execute({ action: "join", room_id: room }, context(bravo.id, ops))
      const firstJoin = yield* roomEntries(sessions, bravo.id)
      // The backlog arrives as ONE batched part: created + two posts, all unread
      // at watermark 0. Counting parts would be 1 and would not distinguish this
      // from a replay, so count entry openings. Bravo's own `joined` is
      // claim-delivered at room.ts:286 before `sync`, so it is not in the batch.
      expect(firstJoin.length).toBe(1)
      expect(roomEntryCount(firstJoin)).toBe(3)
      expect(firstJoin[0]).toContain('type="created"')

      yield* def.execute({ action: "leave" }, context(bravo.id, ops))
      yield* def.execute({ action: "join", room_id: room }, context(bravo.id, ops))

      const afterRejoin = yield* roomEntries(sessions, bravo.id)
      // Only the one event that was never settled for bravo, in a new batched
      // part. A `forget` regression would ALSO arrive as one part, so the
      // discriminating assertion is the entry count, not the part count.
      expect(afterRejoin.length).toBe(firstJoin.length + 1)
      expect(roomEntryCount(afterRejoin)).toBe(roomEntryCount(firstJoin) + 1)
      expect(afterRejoin[afterRejoin.length - 1]).toContain('type="left"')
    }),
    { timeout: 30000 },
  )

  // Delivery re-labels `direction` for the recipient by replacing the first
  // occurrence in the rendered entry. That is only safe because the opening tag
  // always precedes the body, so the first occurrence is always the tag's own.
  it.instance("re-labels only the entry's own direction tag when delivering", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      yield* def.execute({ action: "create" }, context(alpha.id, ops))
      yield* def.execute({ action: "invite", session_id: bravo.id }, context(alpha.id, ops))
      yield* def.execute(
        { action: "post", message: 'quoting direction="outbound" should survive' },
        context(alpha.id, ops),
      )

      const delivered = yield* sessions.messages({ sessionID: bravo.id }).pipe(Effect.orDie)
      const texts = delivered.flatMap((m) =>
        m.parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])),
      )
      const copy = texts.find((text) => text.includes("should survive"))
      expect(copy).toBeDefined()
      // The recipient sees its own copy tagged inbound...
      expect(copy).toContain('direction="inbound"')
      // ...and the post's quoted attribute is passed through verbatim.
      expect(copy).toContain('quoting direction="outbound" should survive')
    }),
    { timeout: 30000 },
  )

  it.instance("tells the reader when skip_events leaves nothing displayable", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      // A room that has been created and joined but never posted to has an
      // all-events transcript. That is the normal state of a fresh room, not a
      // contrived one, so `read` reaches it by ordinary use.
      yield* def.execute({ action: "create" }, context(alpha.id, ops))

      const read = yield* def.execute({ action: "read", skip_events: true }, context(alpha.id, ops))

      expect(read.output).not.toContain("<room_message")
      // Whether events *should* be visible is still an open decision, so this
      // pins only the orthogonal half: the reader must not be handed a bare
      // envelope that is indistinguishable from an empty room.
      expect(read.output).not.toMatch(/<room id="[^"]+">\s*<\/room>/)
      expect(read.output).toContain("skip_events")
    }),
    { timeout: 30000 },
  )

  it.instance("keeps a message that quotes the room_event tag under skip_events", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      yield* def.execute({ action: "create" }, context(alpha.id, ops))
      // Posts that talk *about* the tag, including one that is nothing but a
      // pasted event pair. `renderMessage` wraps every post body in
      // `<room_message>`, so neither the first nor the last characters of the
      // stored entry can come from the post's own text. That is what makes any
      // tag-position classification safe; this pins the behaviour, not one
      // particular way of achieving it.
      yield* def.execute(
        { action: "post", message: 'the leave note renders <room_event type="left"> verbatim' },
        context(alpha.id, ops),
      )
      yield* def.execute(
        {
          action: "post",
          message: '<room_event room="ses_x" type="left" from="ses_y" seq="7">\nquoted\n</room_event>',
        },
        context(alpha.id, ops),
      )
      yield* def.execute({ action: "close" }, context(alpha.id, ops))

      const plain = yield* def.execute({ action: "read" }, context(alpha.id, ops))
      expect(plain.output).toContain('renders <room_event type="left"> verbatim')
      expect(plain.output).toContain("quoted")

      const filtered = yield* def.execute({ action: "read", skip_events: true }, context(alpha.id, ops))
      expect(filtered.output).toContain('renders <room_event type="left"> verbatim')
      expect(filtered.output).toContain("quoted")
      // The genuine event is still filtered, so this is not a blanket keep.
      expect(filtered.output).not.toContain('type="closed"')
    }),
    { timeout: 30000 },
  )

  it.instance("keeps content when skip_events filters the tail of the room", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      yield* def.execute({ action: "create" }, context(alpha.id, ops))
      yield* def.execute({ action: "post", message: "alpha-one" }, context(alpha.id, ops))
      yield* def.execute({ action: "post", message: "alpha-two" }, context(alpha.id, ops))
      // The transcript now ends in events, so slicing before filtering would
      // hand back an empty body and drop real messages that sit above the cut.
      yield* def.execute({ action: "close" }, context(alpha.id, ops))
      yield* def.execute({ action: "open" }, context(alpha.id, ops))

      const cut = yield* def.execute({ action: "read", limit: 1, skip_events: true }, context(alpha.id, ops))
      expect(cut.output).toContain("alpha-two")
      expect(cut.output).not.toContain("alpha-one")
      expect(cut.output).not.toContain("<room_event")
      // The note counts what the reader asked for, so it must be 2 content
      // lines rather than the 5 transcript entries behind them.
      expect(cut.output).toContain("showing the last 1 of 2")

      const all = yield* def.execute({ action: "read", skip_events: true }, context(alpha.id, ops))
      expect(all.output).toContain("alpha-one")
      expect(all.output).toContain("alpha-two")
      expect(all.output).not.toContain("<room_event")
    }),
    { timeout: 30000 },
  )
})

describe("tool.partner talk", () => {
  it.instance("delivers a message to a parent without waiting by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent", agent: "build" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child", agent: "general" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        { action: "talk", session_id: parent.id, message: "status?" },
        context(child.id, stubOps({ onPrompt: (input) => (seen = input) })),
      )

      expect(seen?.sessionID).toBe(parent.id)
      expect(seen?.noReply).toBe(true)
      expect(seen?.agent).toBe("build")
      const part = seen?.parts[0]
      expect(part?.type).toBe("text")
      if (part?.type === "text") {
        expect(part.text).toContain("<agent_message")
        expect(part.text).toContain('sender="agent"')
        expect(part.text).toContain('relation="parent"')
        expect(part.synthetic).not.toBe(true)
      }
      expect(result.output).toContain('state="delivered"')
      expect(result.output).toContain('relation="parent"')
    }),
    { timeout: 30000 },
  )

  it.instance("refuses to partner a room session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const roomTool = yield* RoomTool
      const room = (yield* (yield* roomTool.init()).execute({ action: "create" }, context(alpha.id, persistingOps(sessions))))
        .metadata.room

      const def = yield* (yield* PartnerTool).init()
      const exit = yield* def.execute({ action: "add", session_id: room }, context(alpha.id, stubOps())).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(partnershipOf(yield* sessions.get(room))).toBeUndefined()
    }),
    { timeout: 30000 },
  )

  it.instance("marks a user-initiated message with sender=user", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const partner = yield* PartnerTool
      const partnerDef = yield* partner.init()
      yield* partnerDef.execute({ session_id: bravo.id }, context(alpha.id, stubOps()))

      let seen: SessionPrompt.PromptInput | undefined
      yield* partnerDef.execute(
        { action: "talk", session_id: bravo.id, message: "hello" },
        context(alpha.id, stubOps({ onPrompt: (input) => (seen = input) }), { sender: "user" }),
      )

      const part = seen?.parts[0]
      expect(part?.type).toBe("text")
      if (part?.type === "text") expect(part.text).toContain('sender="user"')
    }),
    { timeout: 30000 },
  )

  it.instance("rejects sessions that are not related", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const a = yield* sessions.create({ title: "A" })
      const b = yield* sessions.create({ title: "B" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute({ action: "talk", session_id: b.id, message: "hi" }, context(a.id, stubOps()))
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
    { timeout: 30000 },
  )

  it.instance("delivers a message to a partner", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()
      yield* def.execute({ session_id: bravo.id }, context(alpha.id, stubOps()))

      let seen: SessionPrompt.PromptInput | undefined
      const result = yield* def.execute(
        { action: "talk", session_id: bravo.id, message: "hello partner" },
        context(alpha.id, stubOps({ onPrompt: (input) => (seen = input) })),
      )

      expect(seen?.sessionID).toBe(bravo.id)
      expect(result.output).toContain('relation="partner"')
    }),
    { timeout: 30000 },
  )

  it.instance("reports partnership status", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* PartnerTool
      const def = yield* tool.init()
      yield* def.execute({ session_id: bravo.id }, context(alpha.id, stubOps()))

      const result = yield* def.execute({ action: "status" }, context(alpha.id, stubOps()))

      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain(bravo.id)
    }),
    { timeout: 30000 },
  )
})

describe("tool.partner broadcast", () => {
  it.instance("delivers one message to every partner", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const charlie = yield* sessions.create({ title: "Charlie", agent: "build" })
      const outsider = yield* sessions.create({ title: "Outsider" })
      const partner = yield* PartnerTool
      const partnerDef = yield* partner.init()
      yield* partnerDef.execute({ session_id: bravo.id }, context(alpha.id, stubOps()))
      yield* partnerDef.execute({ session_id: charlie.id }, context(bravo.id, stubOps()))

      const seen: string[] = []
      const result = yield* partnerDef.execute(
        { action: "broadcast", message: "standup in 5" },
        context(alpha.id, stubOps({ onPrompt: (input) => seen.push(input.sessionID) })),
      )

      expect(seen.toSorted()).toEqual([bravo.id, charlie.id].toSorted())
      expect(seen).not.toContain(outsider.id)
      expect(result.metadata.count).toBe(2)
    }),
    { timeout: 30000 },
  )
})

describe("tool.room", () => {
  it.instance("creates a room and joins it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { action: "create", title: "Philosophy" },
        context(alpha.id, persistingOps(sessions)),
      )
      const room = result.metadata.room

      expect(isRoom(yield* sessions.get(room))).toBe(true)
      expect(roomOf(yield* sessions.get(alpha.id))).toBe(room)
      expect((yield* sessions.get(room)).title).toBe("Philosophy")

      const stored = yield* sessions.messages({ sessionID: room })
      const transcript = stored.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      expect(transcript.some((line) => line.includes('type="created"'))).toBe(true)
    }),
    { timeout: 30000 },
  )

  it.instance("posts to the room and delivers unread backlog to members", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()

      const created = yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      const room = created.metadata.room
      yield* def.execute({ action: "join", room_id: room }, context(bravo.id, persistingOps(sessions)))
      expect(roomOf(yield* sessions.get(bravo.id))).toBe(room)

      const seen: { session: string; text: string }[] = []
      yield* def.execute(
        { action: "post", message: "hello room" },
        context(
          alpha.id,
          persistingOps(sessions, {
            onPrompt: (input) => {
              const part = input.parts[0]
              if (part?.type === "text") seen.push({ session: input.sessionID, text: part.text })
            },
          }),
        ),
      )

      expect(seen.some((item) => item.session === room && item.text.includes("hello room"))).toBe(true)
      expect(seen.some((item) => item.session === bravo.id && item.text.includes("hello room"))).toBe(true)
    }),
    { timeout: 30000 },
  )

  it.instance("invites another session into the room", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const created = yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      const room = created.metadata.room

      yield* def.execute({ action: "invite", session_id: bravo.id }, context(alpha.id, persistingOps(sessions)))

      expect(roomOf(yield* sessions.get(bravo.id))).toBe(room)
    }),
    { timeout: 30000 },
  )

  it.instance("leaves a room", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))

      yield* def.execute({ action: "leave" }, context(alpha.id, persistingOps(sessions)))

      expect(roomOf(yield* sessions.get(alpha.id))).toBeUndefined()
    }),
    { timeout: 30000 },
  )

  it.instance("moving to another room leaves the previous one", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const first = yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      const second = yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))

      expect(roomOf(yield* sessions.get(alpha.id))).toBe(second.metadata.room)
      const inFirst = (yield* sessions.list()).some(
        (item) => item.id === alpha.id && roomOf(item) === first.metadata.room,
      )
      expect(inFirst).toBe(false)
    }),
    { timeout: 30000 },
  )

  it.instance("joining the room you are already in is idempotent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      const room = (yield* def.execute({ action: "create" }, context(alpha.id, ops))).metadata.room
      const before = yield* roomEntries(sessions, room)

      const again = yield* def.execute({ action: "join", room_id: room }, context(alpha.id, ops))
      expect(again.title).toContain("Already in")
      expect((yield* roomEntries(sessions, room)).length).toBe(before.length)
    }),
    { timeout: 30000 },
  )

  it.instance("refuses to invite a session that is already in another room", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      yield* def.execute({ action: "create" }, context(bravo.id, persistingOps(sessions)))

      const exit = yield* def
        .execute({ action: "invite", session_id: bravo.id }, context(alpha.id, persistingOps(sessions)))
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
    { timeout: 30000 },
  )

  it.instance("close stops posts until reopened", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))

      yield* def.execute({ action: "close" }, context(alpha.id, persistingOps(sessions)))
      const blocked = yield* def
        .execute({ action: "post", message: "too late" }, context(alpha.id, persistingOps(sessions)))
        .pipe(Effect.exit)
      expect(Exit.isFailure(blocked)).toBe(true)

      yield* def.execute({ action: "open" }, context(alpha.id, persistingOps(sessions)))
      const allowed = yield* def.execute({ action: "post", message: "back" }, context(alpha.id, persistingOps(sessions)))
      expect(allowed.title).toContain("Posted to")
    }),
    { timeout: 30000 },
  )

  it.instance("assigns a strictly increasing sequence number per post", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const created = yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      const first = yield* def.execute({ action: "post", message: "one" }, context(alpha.id, persistingOps(sessions)))
      const second = yield* def.execute({ action: "post", message: "two" }, context(alpha.id, persistingOps(sessions)))

      expect(created.metadata.seq).toBe(1)
      expect(first.metadata.seq).toBe(2)
      expect(second.metadata.seq).toBe(3)
    }),
    { timeout: 30000 },
  )

  it.instance("kicks another member from the room", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const created = yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      const room = created.metadata.room
      yield* def.execute({ action: "invite", session_id: bravo.id }, context(alpha.id, persistingOps(sessions)))
      expect(roomOf(yield* sessions.get(bravo.id))).toBe(room)

      yield* def.execute({ action: "kick", session_id: bravo.id }, context(alpha.id, persistingOps(sessions)))

      expect(roomOf(yield* sessions.get(bravo.id))).toBeUndefined()
      const stored = yield* sessions.messages({ sessionID: room })
      const transcript = stored.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      expect(transcript.some((line) => line.includes('type="kicked"'))).toBe(true)
    }),
    { timeout: 30000 },
  )

  it.instance("reports room status without the transcript", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      yield* def.execute({ action: "post", message: "secret" }, context(alpha.id, persistingOps(sessions)))

      const status = yield* def.execute({ action: "status" }, context(alpha.id, persistingOps(sessions)))

      expect(status.output).toContain("<room_members>")
      expect(status.output).toContain("members=")
      expect(status.output).not.toContain("secret")
    }),
    { timeout: 30000 },
  )

  it.instance("bounds read output with limit", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      yield* def.execute({ action: "post", message: "first" }, context(alpha.id, persistingOps(sessions)))
      yield* def.execute({ action: "post", message: "second" }, context(alpha.id, persistingOps(sessions)))
      yield* def.execute({ action: "post", message: "third" }, context(alpha.id, persistingOps(sessions)))

      const result = yield* def.execute(
        { action: "read", limit: 1 },
        context(alpha.id, persistingOps(sessions)),
      )

      expect(result.output).toContain("third")
      expect(result.output).not.toContain("first")
    }),
    { timeout: 30000 },
  )

  // The room transcript is unbounded, so `read` must be walkable end to end
  // instead of only ever exposing the newest READ_MAX entries. `after` pages
  // forward (oldest first) using the to_seq emitted by the previous page.
  it.instance("pages the full transcript forward with after", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      yield* def.execute({ action: "create" }, context(alpha.id, ops))
      for (const message of ["m1", "m2", "m3", "m4"]) {
        yield* def.execute({ action: "post", message }, context(alpha.id, ops))
      }

      const pages: string[] = []
      let cursor = 0
      for (let index = 0; index < 10; index++) {
        const page = yield* def.execute({ action: "read", after: cursor, limit: 2 }, context(alpha.id, ops))
        pages.push(page.output)
        if (!page.output.includes('has_newer="true"')) break
        cursor = Number(/to_seq="(\d+)"/.exec(page.output)?.[1])
      }

      const combined = pages.join("\n")
      for (const message of ["m1", "m2", "m3", "m4"]) expect(combined).toContain(message)
      // Each page is bounded, and the walk terminates when nothing newer remains.
      expect(pages[0]).toContain('returned="2"')
      expect(pages[pages.length - 1]).toContain('has_newer="false"')
    }),
    { timeout: 30000 },
  )

  // The default window is the newest entries, but it must advertise older ones
  // so a member knows the transcript continues and can page back with `before`.
  it.instance("advertises older entries and pages back with before", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      yield* def.execute({ action: "create" }, context(alpha.id, ops))
      for (const message of ["m1", "m2", "m3", "m4"]) {
        yield* def.execute({ action: "post", message }, context(alpha.id, ops))
      }

      const newest = yield* def.execute({ action: "read", limit: 2 }, context(alpha.id, ops))
      expect(newest.output).toContain("m4")
      expect(newest.output).not.toContain("m1")
      expect(newest.output).toContain('has_older="true"')
      const fromSeq = Number(/from_seq="(\d+)"/.exec(newest.output)?.[1])

      const older = yield* def.execute({ action: "read", before: fromSeq, limit: 2 }, context(alpha.id, ops))
      expect(older.output).toContain("m2")
      expect(older.output).not.toContain("m4")
    }),
    { timeout: 30000 },
  )

  it.instance("destroy refuses while others remain, then soft-deletes as the last member", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      const room = (yield* def.execute({ action: "create" }, context(alpha.id, ops))).metadata.room
      yield* def.execute({ action: "invite", session_id: bravo.id }, context(alpha.id, ops))
      yield* def.execute({ action: "post", message: "before destroy" }, context(alpha.id, ops))

      // A shared room cannot be destroyed out from under its other members.
      const tooEarly = yield* def.execute({ action: "destroy" }, context(alpha.id, ops)).pipe(Effect.exit)
      expect(Exit.isFailure(tooEarly)).toBe(true)
      expect(roomOf(yield* sessions.get(bravo.id))).toBe(room)

      yield* def.execute({ action: "kick", session_id: bravo.id }, context(alpha.id, ops))
      const destroyed = yield* def.execute({ action: "destroy" }, context(alpha.id, ops))
      expect(destroyed.output).toContain('state="destroyed"')
      expect(roomOf(yield* sessions.get(alpha.id))).toBeUndefined()
      expect(roomOf(yield* sessions.get(bravo.id))).toBeUndefined()
      const info = yield* sessions.get(room)
      expect(info.metadata?.room_state).toBe("destroyed")
      expect(info.time?.archived).toBeDefined()

      // The transcript survives and stays readable by id even with no members.
      const read = yield* def.execute({ action: "read", room_id: room }, context(alpha.id, ops))
      expect(read.output).toContain("before destroy")

      // No longer writable or joinable.
      const post = yield* def
        .execute({ action: "post", room_id: room, message: "after" }, context(alpha.id, ops))
        .pipe(Effect.exit)
      expect(Exit.isFailure(post)).toBe(true)
      const join = yield* def.execute({ action: "join", room_id: room }, context(bravo.id, ops)).pipe(Effect.exit)
      expect(Exit.isFailure(join)).toBe(true)
    }),
    { timeout: 30000 },
  )

  // A busy member must not have a delivery injected into its running turn; the
  // message is queued and flushed on the next idle transition.
  it.instance("defers delivery to a busy member until it is idle", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const ops = persistingOps(sessions)
      const room = (yield* def.execute({ action: "create" }, context(alpha.id, ops))).metadata.room
      yield* def.execute({ action: "invite", session_id: bravo.id }, context(alpha.id, ops))

      yield* statuses.set(bravo.id, { type: "busy" })
      yield* def.execute({ action: "post", message: "deferred" }, context(alpha.id, ops))
      const before = yield* roomEntries(sessions, bravo.id)
      expect(before.some((text) => text.includes("deferred"))).toBe(false)

      yield* statuses.set(bravo.id, { type: "idle" })
      yield* drainDeliveries({ ops, statuses, sessions, scope, db: database.db }, bravo.id)
      const after = yield* roomEntries(sessions, bravo.id)
      expect(after.some((text) => text.includes("deferred"))).toBe(true)
    }),
    { timeout: 30000 },
  )

  // The chain bound stops runaway agent ping-pong, but a user-originated wake
  // must always get through (and reset the bound); otherwise a busy room can
  // leave an agent permanently un-woken.
  it.instance("force wake bypasses the chain bound and resets it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const ops = persistingOps(sessions)
      const deps = { ops, statuses, sessions, scope, db: database.db }
      const chat = yield* sessions.create({
        title: "Chained",
        metadata: { wake_chain: 999, wake_chain_at: Date.now() },
      })

      expect(yield* wake(deps, chat)).toBe(false)
      expect(yield* wake(deps, chat, { force: true })).toBe(true)
      expect((yield* sessions.get(chat.id)).metadata?.wake_chain).toBe(0)
    }),
    { timeout: 30000 },
  )

  it.instance("seeds the counter above a legacy metadata.room_seq behind the transcript", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const db = database.db
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const tool = yield* RoomTool
      const def = yield* tool.init()
      const created = yield* def.execute({ action: "create" }, context(alpha.id, persistingOps(sessions)))
      const room = created.metadata.room
      yield* def.execute({ action: "post", message: "two" }, context(alpha.id, persistingOps(sessions)))
      yield* def.execute({ action: "post", message: "three" }, context(alpha.id, persistingOps(sessions)))

      // Simulate a pre-migration room: no atomic counter row, and a stale legacy
      // key (1) that trails the transcript (max seq 3).
      yield* db.run(sql`DELETE FROM room_seq WHERE room_id = ${room}`).pipe(Effect.orDie)
      yield* sessions.patchMetadata({ sessionID: room, metadata: { room_seq: 1 } })

      const next = yield* def.execute(
        { action: "post", message: "four" },
        context(alpha.id, persistingOps(sessions)),
      )

      expect(next.metadata.seq).toBe(4)
    }),
    { timeout: 30000 },
  )
})

describe("session.lease", () => {
  it.instance("grants a session lease to only one owner at a time", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const db = database.db
      const chat = yield* sessions.create({ title: "Lease" })
      yield* SessionLease.ensure(db)

      expect(yield* SessionLease.claim(db, chat.id, 30000, "A")).toBe(true)
      expect(yield* SessionLease.claim(db, chat.id, 30000, "B")).toBe(false)
      expect(yield* SessionLease.claim(db, chat.id, 30000, "A")).toBe(true)

      yield* db
        .run(sql`UPDATE session_lease SET expires_at = 0 WHERE session_id = ${chat.id}`)
        .pipe(Effect.orDie)
      expect(yield* SessionLease.claim(db, chat.id, 30000, "B")).toBe(true)
    }),
    { timeout: 30000 },
  )

  // `foreignHeld` is what the manager commands use to refuse writing into a
  // session another process is running. It must ignore our own claim (that case
  // is SessionRunState's job) and must not require an explicit release to clear.
  it.instance("foreignHeld ignores our own lease and clears on expiry alone", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const db = database.db
      const mine = yield* sessions.create({ title: "Mine" })
      const theirs = yield* sessions.create({ title: "Theirs" })
      yield* SessionLease.ensure(db)

      expect(yield* SessionLease.foreignHeld(db, mine.id)).toBe(false)

      expect(yield* SessionLease.claim(db, mine.id)).toBe(true)
      expect(yield* SessionLease.foreignHeld(db, mine.id)).toBe(false)

      expect(yield* SessionLease.claim(db, theirs.id, 30000, "elsewhere")).toBe(true)
      expect(yield* SessionLease.foreignHeld(db, theirs.id)).toBe(true)

      yield* db
        .run(sql`UPDATE session_lease SET expires_at = 0 WHERE session_id = ${theirs.id}`)
        .pipe(Effect.orDie)
      expect(yield* SessionLease.foreignHeld(db, theirs.id)).toBe(false)
    }),
    { timeout: 30000 },
  )

  it.instance("release only drops a lease this process owns", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const db = database.db
      const mine = yield* sessions.create({ title: "Mine" })
      const theirs = yield* sessions.create({ title: "Theirs" })
      yield* SessionLease.ensure(db)

      expect(yield* SessionLease.claim(db, theirs.id, 30000, "elsewhere")).toBe(true)
      yield* SessionLease.release(db, theirs.id)
      expect(yield* SessionLease.foreignHeld(db, theirs.id)).toBe(true)

      expect(yield* SessionLease.claim(db, mine.id)).toBe(true)
      yield* SessionLease.release(db, mine.id)
      expect(yield* SessionLease.foreignHeld(db, mine.id)).toBe(false)
      expect(yield* SessionLease.claim(db, mine.id, 30000, "elsewhere")).toBe(true)
    }),
    { timeout: 30000 },
  )
})

describe("session.collaboration boundaries", () => {
  const failureReason = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "ok"

  it.instance("destroy is idempotent and requires membership", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const outsider = yield* sessions.create({ title: "Outsider", agent: "build" })
      const def = yield* (yield* RoomTool).init()
      const ops = persistingOps(sessions)
      const room = (yield* def.execute({ action: "create" }, context(alpha.id, ops))).metadata.room

      const nonMember = yield* def
        .execute({ action: "destroy", room_id: room }, context(outsider.id, ops))
        .pipe(Effect.exit)
      expect(failureReason(nonMember)).toContain("not a member")

      yield* def.execute({ action: "destroy" }, context(alpha.id, ops))
      const again = yield* def.execute({ action: "destroy", room_id: room }, context(alpha.id, ops)).pipe(Effect.exit)
      expect(failureReason(again)).toContain("already destroyed")
    }),
    { timeout: 30000 },
  )

  it.instance("keeps a destroyed room readable by a non-member but not writable", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const outsider = yield* sessions.create({ title: "Outsider", agent: "build" })
      const def = yield* (yield* RoomTool).init()
      const ops = persistingOps(sessions)
      const room = (yield* def.execute({ action: "create" }, context(alpha.id, ops))).metadata.room
      yield* def.execute({ action: "post", message: "archived-line" }, context(alpha.id, ops))
      yield* def.execute({ action: "destroy" }, context(alpha.id, ops))

      const read = yield* def.execute({ action: "read", room_id: room }, context(outsider.id, ops))
      expect(read.output).toContain("archived-line")
      const post = yield* def
        .execute({ action: "post", room_id: room, message: "x" }, context(outsider.id, ops))
        .pipe(Effect.exit)
      expect(Exit.isFailure(post)).toBe(true)
    }),
    { timeout: 30000 },
  )

  it.instance("refuses invite, post, and kick from a session that is not in a room", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const outsider = yield* sessions.create({ title: "Outsider", agent: "build" })
      const def = yield* (yield* RoomTool).init()
      const ops = persistingOps(sessions)
      yield* def.execute({ action: "create" }, context(alpha.id, ops))

      const invite = yield* def
        .execute({ action: "invite", session_id: alpha.id }, context(outsider.id, ops))
        .pipe(Effect.exit)
      expect(failureReason(invite)).toContain("not in a room")
      const post = yield* def
        .execute({ action: "post", message: "x" }, context(outsider.id, ops))
        .pipe(Effect.exit)
      expect(failureReason(post)).toContain("not in a room")
      const kick = yield* def
        .execute({ action: "kick", session_id: alpha.id }, context(outsider.id, ops))
        .pipe(Effect.exit)
      expect(failureReason(kick)).toContain("not in a room")
    }),
    { timeout: 30000 },
  )

  it.instance("refuses to kick yourself or a non-member", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const def = yield* (yield* RoomTool).init()
      const ops = persistingOps(sessions)
      yield* def.execute({ action: "create" }, context(alpha.id, ops))

      const self = yield* def
        .execute({ action: "kick", session_id: alpha.id }, context(alpha.id, ops))
        .pipe(Effect.exit)
      expect(failureReason(self)).toContain("kick yourself")
      const nonMember = yield* def
        .execute({ action: "kick", session_id: bravo.id }, context(alpha.id, ops))
        .pipe(Effect.exit)
      expect(failureReason(nonMember)).toContain("not in room")
    }),
    { timeout: 30000 },
  )

  it.instance("refuses to talk to a room and to remove a non-partner", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const charlie = yield* sessions.create({ title: "Charlie", agent: "build" })
      const room = (yield* (yield* RoomTool).init()).execute(
        { action: "create" },
        context(alpha.id, persistingOps(sessions)),
      )
      const roomID = (yield* room).metadata.room
      const def = yield* (yield* PartnerTool).init()
      yield* def.execute({ action: "add", session_id: bravo.id }, context(alpha.id, stubOps()))

      const toRoom = yield* def
        .execute({ action: "talk", session_id: roomID, message: "hi" }, context(alpha.id, stubOps()))
        .pipe(Effect.exit)
      expect(failureReason(toRoom)).toContain("not a related agent")
      const removeCharlie = yield* def
        .execute({ action: "remove", session_id: charlie.id }, context(alpha.id, stubOps()))
        .pipe(Effect.exit)
      expect(Exit.isFailure(removeCharlie)).toBe(true)
    }),
    { timeout: 30000 },
  )

  it.instance("delivery queue claims in insertion order, exactly once, with TTL recovery", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const db = database.db
      const chat = yield* sessions.create({ title: "Queue" })
      yield* SessionDelivery.enqueue(db, { sessionID: chat.id, body: "one" })
      yield* SessionDelivery.enqueue(db, { sessionID: chat.id, body: "two" })
      expect(yield* SessionDelivery.hasPending(db, chat.id)).toBe(true)

      const claimed = yield* SessionDelivery.claimPending(db, chat.id)
      expect(claimed.map((q) => q.body)).toEqual(["one", "two"])
      // A claim is exclusive until delivered or the TTL elapses.
      expect(yield* SessionDelivery.claimPending(db, chat.id)).toEqual([])
      for (const q of claimed) yield* SessionDelivery.markDelivered(db, q.id)
      expect(yield* SessionDelivery.hasPending(db, chat.id)).toBe(false)

      // A stale claim from a crashed process is re-claimable after the TTL.
      yield* SessionDelivery.enqueue(db, { sessionID: chat.id, body: "three" })
      const first = yield* SessionDelivery.claimPending(db, chat.id, Date.now(), "owner-a", 60_000)
      expect(first.map((q) => q.body)).toEqual(["three"])
      const recovered = yield* SessionDelivery.claimPending(db, chat.id, Date.now() + 120_000, "owner-b", 60_000)
      expect(recovered.map((q) => q.body)).toEqual(["three"])
    }),
    { timeout: 30000 },
  )

  it.instance("deliver defers to the queue when another process holds the lease", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const target = yield* sessions.create({ title: "Remote" })
      yield* SessionLease.ensure(database.db)
      yield* SessionLease.claim(database.db, target.id, 30_000, "another-process")

      const woke = yield* deliver(
        { ops: persistingOps(sessions), statuses, sessions, scope, db: database.db },
        target,
        "remote-hello",
        { wake: true },
      )

      expect(woke).toBe(false)
      expect(yield* SessionDelivery.hasPending(database.db, target.id)).toBe(true)
      const stored = yield* sessions.messages({ sessionID: target.id }).pipe(Effect.orDie)
      const injected = stored.flatMap((m) => m.parts).some((p) => p.type === "text" && p.text?.includes("remote-hello"))
      expect(injected).toBe(false)
    }),
    { timeout: 30000 },
  )

  it.instance("wake enforces the chain bound for agent-originated wakes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const deps = { ops: persistingOps(sessions), statuses, sessions, scope, db: database.db }
      const chat = yield* sessions.create({
        title: "Bounded",
        metadata: { wake_chain: 12, wake_chain_at: Date.now() },
      })

      expect(yield* wake(deps, chat)).toBe(false)
    }),
    { timeout: 30000 },
  )

  it.instance("drain drops a queued delivery whose session no longer exists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const ghost = SessionID.make("ses_ghostdelivery000000000000")
      yield* SessionDelivery.enqueue(database.db, { sessionID: ghost, body: "orphan" })

      yield* drainDeliveries({ ops: persistingOps(sessions), statuses, sessions, scope, db: database.db }, ghost)

      expect(yield* SessionDelivery.hasPending(database.db, ghost)).toBe(false)
    }),
    { timeout: 30000 },
  )

  it.instance("parseSessionID extracts a session id from free text", () =>
    Effect.sync(() => {
      expect(parseSessionID("please message ses_abc123 now")).toBe(SessionID.make("ses_abc123"))
      expect(parseSessionID("nothing to see")).toBeUndefined()
    }),
    { timeout: 30000 },
  )

  it.instance("renders the room line and escapes agent titles", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const solo = yield* sessions.create({ title: "Solo", agent: "build" })
      expect(renderRoster(solo, { siblings: [], children: [], partners: [] })).toBeUndefined()

      const withRoom = renderRoster(solo, { siblings: [], children: [], partners: [], room: "ses_room1" })
      expect(withRoom).toContain('You are in room "ses_room1"')
      expect(withRoom).toContain("room action=read")

      const parent = yield* sessions.create({ title: "<b>&</b>", agent: "build" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child", agent: "build" })
      const roster = renderRoster(child, { parent, siblings: [], children: [], partners: [] })
      expect(roster).toContain("&lt;b&gt;&amp;&lt;/b&gt;")
    }),
    { timeout: 30000 },
  )

  it.instance("classifies explicit partners", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build", metadata: { partners: "p1" } })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build", metadata: { partners: "p1" } })
      const solo = yield* sessions.create({ title: "Solo", agent: "build" })
      expect(relation(alpha, bravo)).toBe("partner")
      expect(relation(alpha, solo)).toBeUndefined()
    }),
    { timeout: 30000 },
  )

  it.instance("caps a single delivery batch and points at the remaining history", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const alpha = yield* sessions.create({ title: "Alpha", agent: "build" })
      const bravo = yield* sessions.create({ title: "Bravo", agent: "build" })
      const def = yield* (yield* RoomTool).init()
      const ops = persistingOps(sessions)
      const room = (yield* def.execute({ action: "create" }, context(alpha.id, ops))).metadata.room
      for (let index = 0; index < 105; index++) {
        yield* def.execute({ action: "post", message: `msg-${index}` }, context(alpha.id, ops))
      }

      // 1 `created` event + 105 posts = 106 unread; one batch delivers 100.
      yield* def.execute({ action: "join", room_id: room }, context(bravo.id, ops))
      const parts = yield* roomEntries(sessions, bravo.id)
      expect(roomEntryCount(parts)).toBe(100)
      expect(parts.join("\n")).toContain("[6 more room entries not shown")
    }),
    { timeout: 30000 },
  )
})

