export * as SessionDelivery from "./delivery"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { SessionID } from "./schema"

type DB = Database.Interface["db"]

// Identity of this process for claim ownership, and the crash-recovery bound:
// a claim left by a killed process is re-claimable after the TTL.
const OWNER = crypto.randomUUID()
const DEFAULT_TTL_MS = 60_000

const ensured = new WeakSet<object>()

/**
 * Drainable queue of async agent-to-agent messages (room deliveries, partner
 * messages) that arrived while the target session was busy. Handing a message
 * to a running session would inject a user turn mid-run and hijack the turn, so
 * delivery is deferred here and flushed when the target next goes idle.
 */
export const ensure = (db: DB): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (ensured.has(db)) return Effect.void
    return db
      .run(sql`
        CREATE TABLE IF NOT EXISTS session_delivery (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          body TEXT NOT NULL,
          wake INTEGER NOT NULL DEFAULT 0,
          force INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          claimed_at INTEGER,
          claimed_by TEXT,
          delivered_at TEXT
        )
      `)
      .pipe(
        Effect.tap(() => Effect.sync(() => ensured.add(db))),
        Effect.orDie,
      )
  })

export interface Queued {
  readonly id: string
  readonly body: string
  readonly wake: boolean
  readonly force: boolean
}

export const enqueue = (
  db: DB,
  input: { sessionID: SessionID; body: string; wake?: boolean; force?: boolean },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* ensure(db)
    yield* db
      .run(sql`
        INSERT INTO session_delivery (id, session_id, body, wake, force, created_at)
        VALUES (
          ${crypto.randomUUID()}, ${input.sessionID}, ${input.body},
          ${input.wake ? 1 : 0}, ${input.force ? 1 : 0}, ${Date.now()}
        )
      `)
      .pipe(Effect.orDie)
  })

/** Whether a session has any message still waiting to be delivered. */
export const hasPending = (db: DB, sessionID: SessionID): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    yield* ensure(db)
    const row = yield* db
      .get<{ id: string }>(sql`
        SELECT id FROM session_delivery WHERE session_id = ${sessionID} AND delivered_at IS NULL LIMIT 1
      `)
      .pipe(Effect.orDie)
    return row !== undefined
  })

/**
 * Atomically claim every deliverable row for a session, ordered by insertion
 * (`rowid`) so a backlog replays in the order it was queued. A row left "in
 * flight" by a crash becomes re-claimable after `ttl`, so nothing is dropped.
 */
export const claimPending = (
  db: DB,
  sessionID: SessionID,
  now = Date.now(),
  owner: string = OWNER,
  ttl = DEFAULT_TTL_MS,
): Effect.Effect<Queued[]> =>
  Effect.gen(function* () {
    yield* ensure(db)
    const rows = yield* db
      .all<{ rowid: number; id: string; body: string; wake: number; force: number }>(sql`
        UPDATE session_delivery
        SET claimed_at = ${now}, claimed_by = ${owner}
        WHERE delivered_at IS NULL
          AND session_id = ${sessionID}
          AND (claimed_at IS NULL OR claimed_at < ${now - ttl})
        RETURNING rowid, id, body, wake, force
      `)
      .pipe(Effect.orDie)
    return rows
      .slice()
      .sort((a, b) => a.rowid - b.rowid)
      .map((row) => ({ id: row.id, body: row.body, wake: row.wake === 1, force: row.force === 1 }))
  })

export const markDelivered = (db: DB, id: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* ensure(db)
    yield* db
      .run(sql`UPDATE session_delivery SET delivered_at = ${new Date().toISOString()} WHERE id = ${id}`)
      .pipe(Effect.orDie)
  })
