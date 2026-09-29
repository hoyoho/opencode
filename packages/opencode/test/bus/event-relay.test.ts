import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Effect, ManagedRuntime } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { relayOnce } from "../../src/bus/event-relay"
import { recentlyEmitted } from "../../src/event-v2-bridge"

test("relays durable events written by other processes and skips deltas", async () => {
  const filename = `/tmp/opencode/event-relay-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  const runtime = ManagedRuntime.make(Database.layerFromPath(filename))
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: "ses_test", seq: 1, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values([
            {
              id: EventV2.ID.make("evt_a"),
              aggregate_id: "ses_test",
              seq: 0,
              type: "message.updated.1",
              data: { sessionID: "ses_test", info: { id: "msg_1" } },
            },
            {
              id: EventV2.ID.make("evt_b"),
              aggregate_id: "ses_test",
              seq: 1,
              type: "message.part.delta.1",
              data: { sessionID: "ses_test", field: "text", delta: "x" },
            },
          ])
          .run()
          .pipe(Effect.orDie)
      }),
    )

    const seen: string[] = []
    const handler = (event: GlobalEvent) => {
      if (typeof event.payload?.type === "string") seen.push(event.payload.type)
    }
    GlobalBus.on("event", handler)
    const cursor = await relayOnce(runtime, 0)
    GlobalBus.off("event", handler)

    expect(seen).toContain("message.updated")
    expect(seen).not.toContain("message.part.delta")
    expect(cursor).toBeGreaterThan(0)
  } finally {
    await runtime.dispose()
  }
})

// Prompt and question events must stay in the process that owns the running
// session, and events this process already emitted must not be echoed back.
test("relays skip prompts and locally emitted ids", async () => {
  const filename = `/tmp/opencode/event-relay-skip-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  const runtime = ManagedRuntime.make(Database.layerFromPath(filename))
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: "ses_test", seq: 2, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values([
            { id: EventV2.ID.make("evt_perm"), aggregate_id: "ses_test", seq: 0, type: "permission.asked.1", data: {} },
            { id: EventV2.ID.make("evt_q"), aggregate_id: "ses_test", seq: 1, type: "question.asked.1", data: {} },
            {
              id: EventV2.ID.make("evt_local"),
              aggregate_id: "ses_test",
              seq: 2,
              type: "message.updated.1",
              data: { sessionID: "ses_test", info: { id: "msg_1" } },
            },
          ])
          .run()
          .pipe(Effect.orDie)
      }),
    )

    recentlyEmitted.add("evt_local")
    const seen: string[] = []
    const handler = (event: GlobalEvent) => {
      if (typeof event.payload?.type === "string") seen.push(event.payload.type)
    }
    GlobalBus.on("event", handler)
    await relayOnce(runtime, 0)
    GlobalBus.off("event", handler)

    expect(seen).not.toContain("permission.asked")
    expect(seen).not.toContain("question.asked")
    // `evt_local` is this process's own event, so the relay must not re-emit it.
    expect(seen).not.toContain("message.updated")
  } finally {
    recentlyEmitted.delete("evt_local")
    await runtime.dispose()
  }
})
