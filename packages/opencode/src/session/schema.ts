import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { SessionV2 } from "@opencode-ai/core/session"
import { statics } from "@opencode-ai/core/schema"

export const SessionID = SessionV2.ID
export type SessionID = Schema.Schema.Type<typeof SessionID>

const sessionIDPattern = /ses_[0-9A-Za-z]+/

/** Extracts a session id token from free-form text so models can pass extra words safely. */
export function parseSessionID(value: string): SessionID | undefined {
  const match = value.match(sessionIDPattern)
  return match ? SessionID.make(match[0]) : undefined
}

export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(
  Schema.brand("MessageID"),
  statics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("message", id)),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>

export const PartID = Schema.String.check(Schema.isStartsWith("prt")).pipe(
  Schema.brand("PartID"),
  statics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("part", id)),
  })),
)

export type PartID = Schema.Schema.Type<typeof PartID>
