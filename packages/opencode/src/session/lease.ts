export * as SessionLease from "./lease"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { SessionID } from "./schema"

type DB = Database.Interface["db"]

// Identity of this process for lease ownership.
const OWNER = crypto.randomUUID()
// TTL is the crash-recovery bound: a killed process leaves a lease that blocks
// wakes only until it expires. Live runs renew well before this.
const DEFAULT_TTL_MS = 90_000

// Databases whose lease table this process has already ensured. Keyed by the
// db handle so the DDL runs once per database, not once per turn.
const ensured = new WeakSet<object>()

export const ensure = (db: DB): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (ensured.has(db)) return Effect.void
    return db
      .run(sql`
        CREATE TABLE IF NOT EXISTS session_lease (
          session_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `)
      .pipe(
        Effect.tap(() => Effect.sync(() => ensured.add(db))),
        Effect.orDie,
      )
  })

/**
 * Atomically claim ownership of a session for this process. Returns true only if
 * this process now holds the lease (fresh insert, expired takeover, or renewal).
 * Another process holding a live lease keeps it, so only one process runs a
 * session at a time across the shared database.
 */
export const claim = (
  db: DB,
  sessionID: SessionID,
  ttlMs = DEFAULT_TTL_MS,
  owner: string = OWNER,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    yield* ensure(db)
    const now = Date.now()
    const row = yield* db
      .get<{ owner_id: string }>(sql`
        INSERT INTO session_lease (session_id, owner_id, expires_at)
        VALUES (${sessionID}, ${owner}, ${now + ttlMs})
        ON CONFLICT(session_id) DO UPDATE
        SET owner_id = excluded.owner_id, expires_at = excluded.expires_at
        WHERE session_lease.expires_at < ${now} OR session_lease.owner_id = ${owner}
        RETURNING owner_id
      `)
      .pipe(Effect.orDie)
    return row !== undefined
  })

export const release = (db: DB, sessionID: SessionID) =>
  Effect.gen(function* () {
    yield* ensure(db)
    yield* db
      .run(sql`DELETE FROM session_lease WHERE session_id = ${sessionID} AND owner_id = ${OWNER}`)
      .pipe(Effect.orDie)
  })

/**
 * Read-only check: is a *different* process currently running this session?
 * Used by the manager commands, which must not write synthetic turns into a
 * session another process is running. Local runs are covered by
 * SessionRunState; this covers the cross-process case.
 */
export const foreignHeld = (db: DB, sessionID: SessionID, now = Date.now()): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    yield* ensure(db)
    const row = yield* db
      .get<{ owner_id: string }>(sql`
        SELECT owner_id FROM session_lease
        WHERE session_id = ${sessionID} AND expires_at >= ${now}
      `)
      .pipe(Effect.orDie)
    return row !== undefined && row.owner_id !== OWNER
  })
