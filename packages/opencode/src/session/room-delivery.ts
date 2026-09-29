export * as RoomDelivery from "./room-delivery"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { SessionID } from "./schema"

type DB = Database.Interface["db"]

const ensured = new WeakSet<object>()
const ensuredSeq = new WeakSet<object>()

/**
 * Per (room, member, message) delivery ledger. Insert-if-absent is atomic, so a
 * message is delivered to a member exactly once no matter how many processes
 * sync concurrently. Kept out of session metadata so event-sourced session
 * updates cannot clobber it.
 */
export const ensure = (db: DB): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (ensured.has(db)) return Effect.void
    return db
      .run(sql`
        CREATE TABLE IF NOT EXISTS room_delivery_msg (
          room_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          delivered_at TEXT,
          PRIMARY KEY (room_id, session_id, message_id)
        )
      `)
      .pipe(
        Effect.tap(() => Effect.sync(() => ensured.add(db))),
        Effect.orDie,
      )
  })

/**
 * Per-room append counter. The increment happens inside a single SQLite
 * upsert, so concurrent posts from different processes can never collide on a
 * sequence number (session metadata read-modify-write could).
 */
export const ensureSeq = (db: DB): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (ensuredSeq.has(db)) return Effect.void
    return db
      .run(sql`
        CREATE TABLE IF NOT EXISTS room_seq (
          room_id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL
        )
      `)
      .pipe(
        Effect.tap(() => Effect.sync(() => ensuredSeq.add(db))),
        Effect.orDie,
      )
  })

/** Whether the atomic counter row already exists for a room (cheap PK lookup). */
export const hasSeq = (db: DB, roomID: SessionID): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    yield* ensureSeq(db)
    const row = yield* db
      .get<{ room_id: string }>(sql`SELECT room_id FROM room_seq WHERE room_id = ${roomID}`)
      .pipe(Effect.orDie)
    return row !== undefined
  })

/**
 * Atomically reserves and returns the next sequence number for a room. `seed`
 * carries a legacy high-water mark so pre-existing rooms keep monotonic
 * sequences; `MAX(seq, seed) + 1` keeps it monotonic even when two processes
 * append concurrently with different seeds.
 */
export const nextSeq = (db: DB, roomID: SessionID, seed = 0): Effect.Effect<number> =>
  Effect.gen(function* () {
    yield* ensureSeq(db)
    const row = yield* db
      .get<{ seq: number }>(sql`
        INSERT INTO room_seq (room_id, seq) VALUES (${roomID}, ${seed} + 1)
        ON CONFLICT(room_id) DO UPDATE SET seq = MAX(seq, ${seed}) + 1
        RETURNING seq
      `)
      .pipe(Effect.orDie)
    if (!row) return yield* Effect.die(new Error("room_seq upsert returned no row"))
    return row.seq
  })

/**
 * Claim a (room, member, message) for delivery. The row is inserted with a
 * NULL `delivered_at` ("in flight"); call `markDelivered` once the message has
 * actually been written to the member. A row left NULL by a crash is
 * re-claimable, so a claimed-but-never-delivered message is recovered rather
 * than lost. `deliveredIds`/`ledger` only count non-null rows.
 */
export const claim = (
  db: DB,
  roomID: SessionID,
  sessionID: SessionID,
  messageID: string,
  seq: number,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    yield* ensure(db)
    const row = yield* db
      .get<{ message_id: string }>(sql`
        INSERT INTO room_delivery_msg (room_id, session_id, message_id, seq, delivered_at)
        VALUES (${roomID}, ${sessionID}, ${messageID}, ${seq}, NULL)
        ON CONFLICT(room_id, session_id, message_id) DO UPDATE
          SET seq = excluded.seq
          WHERE room_delivery_msg.delivered_at IS NULL
        RETURNING message_id
      `)
      .pipe(Effect.orDie)
    return row !== undefined
  })

/** Mark a claimed entry as actually delivered. */
export const markDelivered = (db: DB, roomID: SessionID, sessionID: SessionID, messageID: string) =>
  Effect.gen(function* () {
    yield* ensure(db)
    yield* db
      .run(sql`
        UPDATE room_delivery_msg SET delivered_at = ${new Date().toISOString()}
        WHERE room_id = ${roomID} AND session_id = ${sessionID} AND message_id = ${messageID}
      `)
      .pipe(Effect.orDie)
  })

/** Claim and immediately mark delivered (for entries never sent via sync). */
export const claimDelivered = (
  db: DB,
  roomID: SessionID,
  sessionID: SessionID,
  messageID: string,
  seq: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const won = yield* claim(db, roomID, sessionID, messageID, seq)
    if (won) yield* markDelivered(db, roomID, sessionID, messageID)
  })

// Only delivered rows count: a NULL delivered_at is an in-flight/abandoned
// claim that the watermark and the unread gate must both ignore. With the
// filter, `delivered_at` is the max-seq row's value by construction.
export const ledger = (db: DB, roomID: SessionID) =>
  Effect.gen(function* () {
    yield* ensure(db)
    return yield* db
      .all<{ session_id: string; delivered_seq: number; delivered_at: string | null }>(sql`
        SELECT session_id, MAX(seq) AS delivered_seq, delivered_at
        FROM room_delivery_msg
        WHERE room_id = ${roomID} AND delivered_at IS NOT NULL
        GROUP BY session_id
      `)
      .pipe(Effect.orDie)
  })

/** Message ids already delivered to a member, for computing the unread set. */
export const deliveredIds = (db: DB, roomID: SessionID, sessionID: SessionID): Effect.Effect<Set<string>> =>
  Effect.gen(function* () {
    yield* ensure(db)
    const rows = yield* db
      .all<{ message_id: string }>(sql`
        SELECT message_id FROM room_delivery_msg
        WHERE room_id = ${roomID} AND session_id = ${sessionID} AND delivered_at IS NOT NULL
      `)
      .pipe(Effect.orDie)
    return new Set(rows.map((row) => row.message_id))
  })
