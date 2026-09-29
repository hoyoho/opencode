import { Database } from "@opencode-ai/core/database/database"
import { EventTable } from "@opencode-ai/core/event/sql"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { GlobalBus } from "@/bus/global"
import { recentlyEmitted } from "@/event-v2-bridge"

/**
 * Relays durable events written by other OpenCode processes that share this
 * database by tailing the `event` table. Each process already emits its own
 * events on `GlobalBus`; this only surfaces events this process did not write,
 * so multiple TUIs/instances can see each other's sessions live.
 *
 * Incremental deltas and interactive prompts are intentionally skipped: deltas
 * are not idempotent, and permission/question prompts must stay in the process
 * that owns the running session.
 */
const POLL_MS = 300
const BATCH = 500
const EXCLUDED = new Set([
  "message.part.delta",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
])

type Runtime = {
  runPromise: <A, E>(effect: Effect.Effect<A, E, Database.Service>) => Promise<A>
}
type Row = { readonly rowid: number; readonly id: string; readonly type: string; readonly data: unknown }

const readMaxRowid = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const row = yield* db
        .select({ rowid: sql<number | null>`max(rowid)` })
        .from(EventTable)
        .get()
      return row?.rowid ?? 0
    }).pipe(Effect.orDie),
  )

const readRows = (runtime: Runtime, cursor: number) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return yield* db
        .select({ rowid: sql<number>`rowid`, id: EventTable.id, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(sql`rowid > ${cursor}`)
        .orderBy(sql`rowid`)
        .limit(BATCH)
        .all()
    }).pipe(Effect.orDie),
  ) as Promise<ReadonlyArray<Row>>

export async function relayOnce(runtime: Runtime, cursor: number): Promise<number> {
  const rows = await readRows(runtime, cursor)
  let next = cursor
  for (const row of rows) {
    next = row.rowid
    if (recentlyEmitted.has(row.id)) continue
    const type = row.type.replace(/\.\d+$/, "")
    if (EXCLUDED.has(type)) continue
    GlobalBus.emit("event", {
      directory: "global",
      payload: { id: row.id, type, properties: row.data },
    })
  }
  return next
}

export function startEventRelay(runtime: Runtime) {
  let cursor: number | undefined
  let polling = false

  const tick = async () => {
    if (polling) return
    polling = true
    try {
      if (cursor === undefined) {
        cursor = await readMaxRowid(runtime)
        return
      }
      cursor = await relayOnce(runtime, cursor)
    } catch {
      // Transient read failures are ignored; the next tick retries.
    } finally {
      polling = false
    }
  }

  const timer = setInterval(() => void tick(), POLL_MS)
  timer.unref?.()
}
