import { describe, expect, it } from "bun:test"
import { parseManagerCommand } from "../../src/session/manager-commands"

describe("session.manager-commands", () => {
  it("parses /roommgr subcommands", () => {
    expect(parseManagerCommand("roommgr", "new Philosophy")).toEqual({
      tool: "room",
      params: { action: "create", title: "Philosophy" },
    })
    expect(parseManagerCommand("roommgr", "new")).toEqual({ tool: "room", params: { action: "create" } })
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
    expect(parseManagerCommand("roommgr", "say hello there world")).toEqual({
      tool: "room",
      params: { action: "post", message: "hello there world" },
    })
    // `read` was removed from the command layer; agents still have the tool.
    expect(parseManagerCommand("roommgr", "read ses_abc 25")).toHaveProperty("error")
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
    expect(parseManagerCommand("partnermgr", "leave")).toEqual({ tool: "partner", params: { action: "leave" } })
    expect(parseManagerCommand("partnermgr", "broadcast standup in five")).toEqual({
      tool: "partner",
      params: { action: "broadcast", message: "standup in five" },
    })
    // `tell` was removed from the command layer; agents still have the talk tool.
    expect(parseManagerCommand("partnermgr", "tell ses_abc please review")).toHaveProperty("error")
    // remove requires an explicit session id; leaving is `leave`.
    expect(parseManagerCommand("partnermgr", "remove")).toHaveProperty("error")
    expect(parseManagerCommand("partnermgr", "status")).toEqual({ tool: "partner", params: { action: "status" } })
  })

  it("ignores non-manager commands", () => {
    expect(parseManagerCommand("init", "")).toBeUndefined()
    expect(parseManagerCommand("review", "")).toBeUndefined()
  })

  // The body is kept verbatim: only a single pair of wrapping quotes around the
  // whole remainder is removed, so internal spacing, newlines, and quotes (code,
  // JSON, markdown) reach the transcript unchanged.
  it("preserves the message body verbatim", () => {
    expect(parseManagerCommand("roommgr", "say \"hello   world\"")).toEqual({
      tool: "room",
      params: { action: "post", message: "hello   world" },
    })
    expect(parseManagerCommand("roommgr", "new \"My Room\"")).toEqual({
      tool: "room",
      params: { action: "create", title: "My Room" },
    })
    // Only a wholly-wrapping quote pair is removed; inner quotes stay.
    expect(parseManagerCommand("partnermgr", "broadcast \"a b\" c")).toEqual({
      tool: "partner",
      params: { action: "broadcast", message: "\"a b\" c" },
    })
    expect(parseManagerCommand("roommgr", "say 'single'")).toEqual({
      tool: "room",
      params: { action: "post", message: "single" },
    })
    // Multi-line and structured content is not collapsed or re-spaced.
    expect(parseManagerCommand("roommgr", "say line1\nline2")).toEqual({
      tool: "room",
      params: { action: "post", message: "line1\nline2" },
    })
    expect(parseManagerCommand("roommgr", "say { \"a\": 1 }")).toEqual({
      tool: "room",
      params: { action: "post", message: "{ \"a\": 1 }" },
    })
    expect(parseManagerCommand("roommgr", "say   spaced   out")).toEqual({
      tool: "room",
      params: { action: "post", message: "spaced   out" },
    })
  })
})
