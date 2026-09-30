import type { Database } from "@opencode-ai/core/database/database"
import type { Session } from "@/session/session"
import type { SessionStatus } from "@/session/status"
import type { SessionID } from "../session/schema"
import { SessionLease } from "../session/lease"
import { SessionDelivery } from "../session/delivery"
import type { TaskPromptOps } from "./task"
import { Effect, Scope } from "effect"

// Bounds agent-to-agent wake chains so a burst of mutual replies cannot loop
// forever. User-originated deliveries bypass (and reset) this bound, so a human
// posting to a room always wakes the agent. Informational deliveries
// (membership/room events) must not wake at all; only real messages do.
const MAX_CHAIN = 12
const WINDOW_MS = 3 * 60 * 1000

export interface WakeDeps {
  readonly ops: TaskPromptOps
  readonly statuses: SessionStatus.Interface
  readonly sessions: Session.Interface
  readonly scope: Scope.Scope
  readonly db: Database.Interface["db"]
}

/**
 * Wakes an idle session to process delivered messages. Bounded by a chain limit
 * and gated by a cross-process lease so at most one process runs a session.
 */
export function wake(deps: WakeDeps, target: Session.Info, options: { force?: boolean } = {}): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const status = yield* deps.statuses.get(target.id)
    if (status.type !== "idle") return false
    const metadata = target.metadata ?? {}
    const now = Date.now()
    const within = typeof metadata.wake_chain_at === "number" && now - metadata.wake_chain_at < WINDOW_MS
    const chain = within && typeof metadata.wake_chain === "number" ? metadata.wake_chain : 0
    const force = options.force === true
    if (!force && chain >= MAX_CHAIN) return false
    yield* SessionLease.ensure(deps.db)
    const owned = yield* SessionLease.claim(deps.db, target.id)
    if (!owned) return false
    yield* deps.sessions.patchMetadata({
      sessionID: target.id,
      metadata: force ? { wake_chain: 0, wake_chain_at: now } : { wake_chain: chain + 1, wake_chain_at: now },
    })
    yield* deps.ops.loop(target.id).pipe(Effect.forkIn(deps.scope, { startImmediately: true }))
    return true
  })
}

/**
 * Deliver one async message. The message is admitted into the target session
 * immediately, so it is visible as a queued turn (the TUI shows it as QUEUED)
 * rather than hidden in `session_delivery`; a running turn promotes it at its
 * next boundary. When `wake` is set, a wake marker is queued and the target is
 * woken now if it is idle, otherwise when it next goes idle. Returns whether the
 * target was woken now.
 */
export function deliver(
  deps: WakeDeps,
  target: Session.Info,
  body: string,
  options: { wake?: boolean; force?: boolean; ignored?: boolean } = {},
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    yield* deps.ops.prompt({
      sessionID: target.id,
      agent: target.agent,
      parts: [{ type: "text", text: body, ...(options.ignored ? { ignored: true } : {}) }],
      noReply: true,
    })
    if (options.wake !== true) return false
    yield* SessionDelivery.enqueue(deps.db, {
      sessionID: target.id,
      body,
      wake: true,
      force: options.force,
      admitted: true,
    })
    const woke = yield* drainDeliveries(deps, target.id)
    if (woke) return true
    // The row is claimed in-process only when idle; a foreign holder may have
    // released its lease between the marker write and here, so try once more.
    return yield* wake(deps, target, { force: options.force })
  })
}

/**
 * Flush queued deliveries for an idle session and wake it to process them. Run
 * when a session transitions to idle (see SessionRunState.setOnIdle). A row
 * whose body was already admitted (a wake marker) is not prompted again; it only
 * triggers the wake. Returns whether the session was woken.
 */
export function drainDeliveries(deps: WakeDeps, sessionID: SessionID): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const status = yield* deps.statuses.get(sessionID)
    if (status.type !== "idle") return false
    yield* SessionLease.ensure(deps.db)
    if (yield* SessionLease.foreignHeld(deps.db, sessionID)) return false
    const claimed = yield* SessionDelivery.claimPending(deps.db, sessionID)
    if (claimed.length === 0) return false
    const target = yield* deps.sessions.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (!target) {
      yield* Effect.forEach(claimed, (item) => SessionDelivery.markDelivered(deps.db, item.id), { discard: true })
      return false
    }
    for (const item of claimed) {
      if (!item.admitted)
        yield* deps.ops.prompt({
          sessionID,
          agent: target.agent,
          parts: [{ type: "text", text: item.body }],
          noReply: true,
        })
      yield* SessionDelivery.markDelivered(deps.db, item.id)
    }
    if (!claimed.some((item) => item.wake)) return false
    return yield* wake(deps, target, { force: claimed.some((item) => item.force) })
  })
}
