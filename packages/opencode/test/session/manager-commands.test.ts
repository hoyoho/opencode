import { describe, expect, it } from "bun:test"
import { parseManagerCommand } from "../../src/session/manager-commands"

describe("session.manager-commands", () => {
  it("parses /roommgr subcommands", () => {
    expect(parseManagerCommand("roommgr", "create Philosophy")).toEqual({
      tool: "room",
      params: { action: "create", title: "Philosophy" },
    })
    expect(parseManagerCommand("roommgr", "create")).toEqual({ tool: "room", params: { action: "create" } })
    expect(parseManagerCommand("roommgr", "join ses_abc")).toEqual({
      tool: "room",
      params: { action: "join", room_id: "ses_abc" },
    })
    expect(parseManagerCommand("roommgr", "leave")).toEqual({ tool: "room", params: { action: "leave" } })
    expect(parseManagerCommand("roommgr", "destroy")).toEqual({ tool: "room", params: { action: "destroy" } })
    expect(parseManagerCommand("roommgr", "destroy ses_room")).toEqual({
      tool: "room",
      params: { action: "destroy", room_id: "ses_room" },
    })
    expect(parseManagerCommand("roommgr", "post hello there world")).toEqual({
      tool: "room",
      params: { action: "post", message: "hello there world" },
    })
    expect(parseManagerCommand("roommgr", "read ses_abc 25")).toEqual({
      tool: "room",
      params: { action: "read", room_id: "ses_abc", limit: 25 },
    })
    expect(parseManagerCommand("roommgr", "read")).toEqual({ tool: "room", params: { action: "read" } })
    expect(parseManagerCommand("roommgr", "status")).toEqual({ tool: "room", params: { action: "status" } })
    expect(parseManagerCommand("roommgr", "kick")).toEqual({
      error: "Usage: /roommgr kick <session-id>",
    })
    expect(parseManagerCommand("roommgr", "bogus")).toHaveProperty("error")
  })

  it("parses /partnermgr subcommands", () => {
    expect(parseManagerCommand("partnermgr", "add ses_abc")).toEqual({
      tool: "partner",
      params: { action: "add", session_id: "ses_abc" },
    })
    // `leave` was folded into `remove <your own id>`; the subcommand is gone.
    expect(parseManagerCommand("partnermgr", "leave")).toHaveProperty("error")
    expect(parseManagerCommand("partnermgr", "broadcast standup in five")).toEqual({
      tool: "partner",
      params: { action: "broadcast", message: "standup in five" },
    })
    expect(parseManagerCommand("partnermgr", "talk ses_abc please review")).toEqual({
      tool: "partner",
      params: { action: "talk", session_id: "ses_abc", message: "please review" },
    })
    expect(parseManagerCommand("partnermgr", "talk ses_abc")).toHaveProperty("error")
    // remove requires an explicit session id; use your own id to detach.
    expect(parseManagerCommand("partnermgr", "remove")).toHaveProperty("error")
    expect(parseManagerCommand("partnermgr", "status")).toEqual({ tool: "partner", params: { action: "status" } })
  })

  it("ignores non-manager commands", () => {
    expect(parseManagerCommand("init", "")).toBeUndefined()
    expect(parseManagerCommand("review", "")).toBeUndefined()
  })

  // Subcommands were renamed to match the agent tool action names exactly.
  it("rejects the pre-unification subcommand aliases", () => {
    expect(parseManagerCommand("roommgr", "new X")).toHaveProperty("error")
    expect(parseManagerCommand("roommgr", "say hi")).toHaveProperty("error")
    expect(parseManagerCommand("partnermgr", "tell ses_abc hi")).toHaveProperty("error")
    expect(parseManagerCommand("partnermgr", "leave")).toHaveProperty("error")
  })

  // `read` picks the first ses_-prefixed token as the room and the first bare
  // integer as the limit, so a stray number or a non-session token is silently
  // dropped rather than rejected. Pinned so the rule is a decision, not an
  // accident; tighten the parser if that is not the intent.
  it("read disambiguates room id and limit leniently", () => {
    expect(parseManagerCommand("roommgr", "read 25")).toEqual({ tool: "room", params: { action: "read", limit: 25 } })
    expect(parseManagerCommand("roommgr", "read abc 25")).toEqual({
      tool: "room",
      params: { action: "read", limit: 25 },
    })
    expect(parseManagerCommand("roommgr", "read ses_abc 25 50")).toEqual({
      tool: "room",
      params: { action: "read", room_id: "ses_abc", limit: 25 },
    })
    // 0 is falsy, so it is dropped and the read falls back to the default.
    expect(parseManagerCommand("roommgr", "read ses_abc 0")).toEqual({
      tool: "room",
      params: { action: "read", room_id: "ses_abc" },
    })
  })

  // `read` cursors are seq-based, so they use the explicit `after=`/`before=`
  // form and never collide with the bare-integer `limit`.
  it("parses read cursors", () => {
    expect(parseManagerCommand("roommgr", "read after=0")).toEqual({
      tool: "room",
      params: { action: "read", after: 0 },
    })
    expect(parseManagerCommand("roommgr", "read ses_abc 25 after=10 before=90")).toEqual({
      tool: "room",
      params: { action: "read", room_id: "ses_abc", limit: 25, after: 10, before: 90 },
    })
    // `skip_events` mirrors the room tool's parameter for command/action parity.
    expect(parseManagerCommand("roommgr", "read skip_events")).toEqual({
      tool: "room",
      params: { action: "read", skip_events: true },
    })
    expect(parseManagerCommand("roommgr", "read ses_abc 10 skip_events")).toEqual({
      tool: "room",
      params: { action: "read", room_id: "ses_abc", limit: 10, skip_events: true },
    })
  })

  // Fixed: the free-text remainder now runs through `tokenize`, so surrounding
  // quotes are removed before the payload reaches the room transcript.
  it("strips quotes from quoted arguments", () => {
    expect(parseManagerCommand("roommgr", "post \"hello   world\"")).toEqual({
      tool: "room",
      params: { action: "post", message: "hello   world" },
    })
    expect(parseManagerCommand("roommgr", "create \"My Room\"")).toEqual({
      tool: "room",
      params: { action: "create", title: "My Room" },
    })
    expect(parseManagerCommand("partnermgr", "talk ses_abc \"multi word message\"")).toEqual({
      tool: "partner",
      params: { action: "talk", session_id: "ses_abc", message: "multi word message" },
    })
    expect(parseManagerCommand("partnermgr", "broadcast \"a b\" c")).toEqual({
      tool: "partner",
      params: { action: "broadcast", message: "a b c" },
    })
    expect(parseManagerCommand("roommgr", "post 'single'")).toEqual({
      tool: "room",
      params: { action: "post", message: "single" },
    })
  })
})
