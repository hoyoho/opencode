export * as SessionInterrupt from "./interrupt"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { SessionID } from "./schema"

type DB = Database.Interface["db"]

const ensured = new WeakSet<object>()

/**
 * Cross-process interrupt requests. A room/partner wake can run a session in the
 * process that delivered the message, so the target's own process has no runner
 * to cancel. The target's process holds the session lease and polls this table,
 * so a request written by any process reaches whichever process is running it.
 */
export const ensure = (db: DB): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (ensured.has(db)) return Effect.void
    return db
      .run(sql`
        CREATE TABLE IF NOT EXISTS session_interrupt (
          session_id TEXT PRIMARY KEY,
          requested_at INTEGER NOT NULL
        )
      `)
      .pipe(
        Effect.tap(() => Effect.sync(() => ensured.add(db))),
        Effect.orDie,
      )
  })

/** Ask whichever process runs this session to interrupt it. Idempotent. */
export const request = (db: DB, sessionID: SessionID): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* ensure(db)
    yield* db
      .run(sql`
        INSERT INTO session_interrupt (session_id, requested_at)
        VALUES (${sessionID}, ${Date.now()})
        ON CONFLICT(session_id) DO UPDATE SET requested_at = excluded.requested_at
      `)
      .pipe(Effect.orDie)
  })

/** Whether an unhandled interrupt request exists for this session. */
export const pending = (db: DB, sessionID: SessionID): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    yield* ensure(db)
    const row = yield* db
      .get<{ session_id: string }>(sql`SELECT session_id FROM session_interrupt WHERE session_id = ${sessionID}`)
      .pipe(Effect.orDie)
    return row !== undefined
  })

export const clear = (db: DB, sessionID: SessionID): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* ensure(db)
    yield* db.run(sql`DELETE FROM session_interrupt WHERE session_id = ${sessionID}`).pipe(Effect.orDie)
  })
