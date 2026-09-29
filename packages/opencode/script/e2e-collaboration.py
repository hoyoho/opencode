#!/usr/bin/env python3
"""HTTP end-to-end suite for the room/partner collaboration feature.

Drives the real server over its HTTP API (the same API the web UI uses), which
is how the feature is exercised in practice. Covers room lifecycle, paging,
delivery semantics, deferred delivery + wake, manager commands, partnerships,
and cross-process behaviour.

Two server processes sharing one database are started automatically (needed for
the cross-process cases: session lease, foreign-busy refusal, cross-process
deferred delivery). Prerequisites: `bun` on PATH and dependencies installed.

Usage:
    python3 packages/opencode/script/e2e-collaboration.py

Env overrides:
    OPENCODE_E2E_A     port for process A (default 4096)
    OPENCODE_E2E_B     port for process B (default 4097)
    OPENCODE_E2E_DIR   working directory for sessions (default /tmp/opencode/e2e)
    BUN                bun binary (default "bun")
"""
import json, os, re, signal, subprocess, sys, threading, time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
A = int(os.environ.get("OPENCODE_E2E_A", "4096"))
B = int(os.environ.get("OPENCODE_E2E_B", "4097"))
D = os.environ.get("OPENCODE_E2E_DIR", "/tmp/opencode/e2e")
BUN = os.environ.get("BUN", "bun")
RESULTS = []
STARTED = []


def call(port, method, path, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    req = Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                  headers={"content-type": "application/json"})
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except HTTPError as e:
        try: return json.load(e)
        except Exception: return {"_http": e.code}


def get(port, path, timeout=30):
    return call(port, "GET", path, None, timeout)


def reachable(port):
    try:
        return get(port, "/doc", 3) is not None
    except Exception:
        return False


def ensure_servers():
    for port in (A, B):
        if reachable(port):
            continue
        p = subprocess.Popen([BUN, "run", "./src/index.ts", "serve", "--port", str(port), "--hostname", "127.0.0.1"],
                             cwd=PKG, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        STARTED.append(p)
        for _ in range(60):
            time.sleep(1)
            if reachable(port):
                break
        if not reachable(port):
            print(f"server on {port} did not come up", file=sys.stderr)
            shutdown()
            sys.exit(2)


def shutdown():
    for p in STARTED:
        try: os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        except Exception: pass


def new_session(port):
    return call(port, "POST", f"/session?directory={D}",
                {"model": {"id": "big-pickle", "providerID": "opencode"}})["id"]


def cmd(port, sid, command, args=""):
    d = call(port, "POST", f"/session/{sid}/command?directory={D}",
             {"command": command, "arguments": args, "agent": "build", "model": "opencode/big-pickle"})
    if isinstance(d, dict) and "parts" in d:
        return "\n".join(p.get("text", "") for p in d["parts"] if p.get("type") == "text")
    return "ERR:" + json.dumps(d)[:300]


def meta(port, sid):
    d = get(port, f"/session/{sid}?directory={D}")
    return (d.get("metadata") or {}) if isinstance(d, dict) else {}


def room_of(port, sid): return meta(port, sid).get("room")
def partners_of(port, sid): return meta(port, sid).get("partners")


def msgs(port, sid):
    d = get(port, f"/session/{sid}/message?directory={D}")
    return d if isinstance(d, list) else []


def count(port, sid, token):
    return sum(token in (p.get("text") or "") for m in msgs(port, sid) for p in m.get("parts", []))


def all_text(port, sid):
    return "\n".join((p.get("text") or "") for m in msgs(port, sid) for p in m.get("parts", []))


def joined_events(port, room, who):
    return sum(1 for m in msgs(port, room) for p in m.get("parts", [])
               if 'type="joined"' in (p.get("text") or "") and who in (p.get("text") or ""))


def status_of(port, sid):
    d = get(port, f"/session/status?directory={D}")
    return d.get(sid) if isinstance(d, dict) else None


def start_shell(port, sid, command, timeout=90):
    def run():
        try:
            call(port, "POST", f"/session/{sid}/shell?directory={D}",
                 {"agent": "build", "model": {"providerID": "opencode", "modelID": "big-pickle"}, "command": command}, timeout=timeout)
        except Exception: pass
    t = threading.Thread(target=run, daemon=True); t.start(); return t


def check(cid, name, cond, detail=""):
    RESULTS.append((cid, name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + cid + " " + name + ("" if cond else "  << " + str(detail)[:220]))


def run():
    # ===== R: room lifecycle =====
    a, b, c = new_session(A), new_session(A), new_session(A)
    t = cmd(A, a, "roommgr", "create SuiteRoom")
    room = room_of(A, a)
    check("R01", "create -> room id, seq1", "Room created and joined" in t and 'seq="1"' in t and (room or "").startswith("ses_"), t)
    check("R02", "join -> both members", "Joined room" in cmd(A, b, "roommgr", f"join {room}") and room_of(A, a) == room and room_of(A, b) == room)
    jb = joined_events(A, room, b)
    t = cmd(A, b, "roommgr", f"join {room}")
    check("R03", "join same room idempotent", "already in the room" in t and joined_events(A, room, b) == jb, t)
    check("R04", "invite already-member no-op", "already in the room" in cmd(A, a, "roommgr", f"invite {b}"))
    other = new_session(A); cmd(A, other, "roommgr", "create Other")
    check("R05", "invite session in other room refused", "already in room" in cmd(A, a, "roommgr", f"invite {other}"))
    check("R06", "invite a room session refused", "Unknown session" in cmd(A, a, "roommgr", f"invite {room}"))
    check("R07", "invite unknown id refused", "Unknown session" in cmd(A, a, "roommgr", "invite ses_deadbeef0000000000000"))
    check("R08", "kick member works + kicked event", "Removed" in cmd(A, a, "roommgr", f"kick {b}") and room_of(A, b) is None
          and 'type="kicked"' in all_text(A, room))
    check("R09", "kick self refused", "kick yourself" in cmd(A, a, "roommgr", f"kick {a}"))
    check("R10", "kick non-member refused", "not in room" in cmd(A, a, "roommgr", f"kick {c}"))
    cmd(A, b, "roommgr", f"join {room}")
    check("R11", "leave clears membership", "Left room" in cmd(A, b, "roommgr", "leave") and room_of(A, b) is None)
    cmd(A, b, "roommgr", f"join {room}")
    cmd(A, a, "roommgr", "close")
    check("R12", "close stops posts", "is closed" in cmd(A, a, "roommgr", "post x"))
    check("R13", "open resumes posts", "Room opened" in cmd(A, a, "roommgr", "open") and "Message posted" in cmd(A, a, "roommgr", "post hi"))
    st = cmd(A, a, "roommgr", "status")
    check("R14", "status lists members+ledger", "<room_members>" in st and "delivered_seq" in st, st[:120])
    check("R15", "non-member read refused", "not a member" in cmd(A, c, "roommgr", f"read {room}"))
    check("R16", "not-in-room read refused", "not in a room" in cmd(A, c, "roommgr", "read"))

    # ===== D: destroy =====
    d1, d2 = new_session(A), new_session(A)
    cmd(A, d1, "roommgr", "create DestroyMe"); dr = room_of(A, d1)
    cmd(A, d2, "roommgr", f"join {dr}")
    check("D01", "destroy with others present refused", "still has 1 other member" in cmd(A, d1, "roommgr", "destroy"))
    cmd(A, d2, "roommgr", "leave")
    t = cmd(A, d1, "roommgr", "destroy")
    info = get(A, f"/session/{dr}?directory={D}")
    check("D02", "destroy as last member works + archived", 'state="destroyed"' in t
          and (info.get("metadata") or {}).get("room_state") == "destroyed" and (info.get("time") or {}).get("archived"))
    check("D03", "destroy again refused", "already destroyed" in cmd(A, d1, "roommgr", f"destroy {dr}"))
    e1, e2 = new_session(A), new_session(A)
    cmd(A, e1, "roommgr", "create LiveRoom"); er = room_of(A, e1)
    cmd(A, e2, "roommgr", f"join {er}")
    check("D04", "non-member destroy refused", "not a member" in cmd(A, c, "roommgr", f"destroy {er}"))
    check("D05", "destroyed read by non-member, not writable",
          ("destroyed" in cmd(A, c, "roommgr", f"read {dr}")) and ("not in a room" in cmd(A, c, "roommgr", "post x") or "destroyed" in cmd(A, c, "roommgr", "post x")))

    # ===== P: paging =====
    p1, p2 = new_session(A), new_session(A)
    cmd(A, p1, "roommgr", "create PageRoom"); pr = room_of(A, p1)
    cmd(A, p2, "roommgr", f"join {pr}")
    for i in range(1, 6): cmd(A, p1, "roommgr", f"post m{i}")
    check("P01", "default window + room_page older", 'room_page' in cmd(A, p1, "roommgr", f"read {pr} 2") and 'has_older="true"' in cmd(A, p1, "roommgr", f"read {pr} 2"))
    seen, cur = set(), 0
    for _ in range(12):
        page = cmd(A, p1, "roommgr", f"read {pr} 2 after={cur}")
        for tok in ("m1", "m2", "m3", "m4", "m5"):
            if tok in page: seen.add(tok)
        m = re.search(r'to_seq="(\d+)"', page)
        if 'has_newer="true"' not in page or not m: break
        cur = int(m.group(1))
    check("P02", "forward paging covers all", seen >= {"m1", "m2", "m3", "m4", "m5"}, seen)
    bw = cmd(A, p1, "roommgr", f"read {pr} 2 before=4")
    check("P03", "backward paging works", ("m1" in bw) or ("m2" in bw), bw[:150])
    check("P04", "non-numeric limit token ignored (default read)", "m5" in cmd(A, p1, "roommgr", f"read {pr} -5"))
    skip = cmd(A, p1, "roommgr", f"read {pr} 100 skip_events")
    check("P05", "skip_events hides events", "<room_event" not in skip and "m5" in skip, skip[:150])

    # ===== X: delivery semantics =====
    xx = new_session(A); cmd(A, xx, "roommgr", "create DeliveryRoom"); xr = room_of(A, xx)
    cmd(A, xx, "roommgr", "post one"); cmd(A, xx, "roommgr", "post two")
    xm = new_session(A); cmd(A, xm, "roommgr", f"join {xr}")
    batch = all_text(A, xm)
    check("X01", "new member gets backlog", "one" in batch and "two" in batch and 'type="created"' in batch, batch[:120])
    check("X03", "direction re-labelled inbound", 'direction="inbound"' in batch, batch[:120])
    cmd(A, xx, "roommgr", "create Bigroom"); br = room_of(A, xx)
    for i in range(105): cmd(A, xx, "roommgr", f"post b{i}")
    bm = new_session(A); cmd(A, bm, "roommgr", f"join {br}")
    bt = all_text(A, bm); n = bt.count("<room_message") + bt.count("<room_event")
    check("X04", "batch capped 100 + pointer", "more room entries not shown" in bt and n == 100, (n, bt.count("more room entries")))

    # ===== F: deferred/wake single-process =====
    f1, f2 = new_session(A), new_session(A)
    cmd(A, f1, "roommgr", "create DeferRoom"); fr = room_of(A, f1)
    cmd(A, f2, "roommgr", f"join {fr}")
    start_shell(A, f2, "sleep 14"); time.sleep(3)
    check("F01", "shell -> busy", (status_of(A, f2) or {}).get("type") == "busy", status_of(A, f2))
    cmd(A, f1, "roommgr", "post during-sleep"); time.sleep(2)
    check("F02", "busy member not injected", count(A, f2, "during-sleep") == 0)
    time.sleep(14)
    check("F03", "flushed after idle", count(A, f2, "during-sleep") >= 1)

    # ===== M: manager commands =====
    m1 = new_session(A)
    check("M01", "runs directly (no model)", "Room created" in cmd(A, m1, "roommgr", "create M"))
    check("M02", "old alias /roommgr new rejected", "Unknown roommgr subcommand: new" in cmd(A, m1, "roommgr", "new X"))
    check("M03", "post ok / say rejected", "Message posted" in cmd(A, m1, "roommgr", "post hi")
          and "Unknown roommgr subcommand: say" in cmd(A, m1, "roommgr", "say hi"))
    nb = len(msgs(A, m1)); cmd(A, m1, "roommgr", "status"); na = len(msgs(A, m1))
    check("M04", "records user+assistant pair", na - nb == 2 and (msgs(A, m1)[nb]["info"]["role"] == "user"), (nb, na))
    mb = new_session(A); cmd(A, mb, "roommgr", "create BusyRoom")
    start_shell(A, mb, "sleep 14"); time.sleep(3)
    r = cmd(A, mb, "roommgr", "status")
    check("M05", "non-detach refused while busy", "SessionBusyError" in r or "busy" in r.lower(), r[:140])
    r = cmd(A, mb, "roommgr", "leave")
    check("M05b", "leave interrupts + succeeds while busy", "Left room" in r, r[:140])
    time.sleep(2)
    mm, mm2 = new_session(A), new_session(A)
    cmd(A, mm, "partnermgr", f"add {mm2}")
    check("M06", "partnermgr talk ok / tell rejected", 'state="delivered"' in cmd(A, mm, "partnermgr", f"talk {mm2} hi")
          and "Unknown partnermgr subcommand: tell" in cmd(A, mm, "partnermgr", f"tell {mm2} hi"))
    check("M07", "leave rejected / remove self detaches", "Unknown partnermgr subcommand: leave" in cmd(A, mm, "partnermgr", "leave")
          and "You left the partnership" in cmd(A, mm, "partnermgr", f"remove {mm}"))

    # ===== N: partner =====
    n1, n2 = new_session(A), new_session(A)
    cmd(A, n1, "partnermgr", f"add {n2}")
    p = partners_of(A, n1)
    check("N01", "add links both sides", p and p == partners_of(A, n2), p)
    cmd(A, n1, "partnermgr", f"add {n2}")
    check("N01b", "re-add idempotent", partners_of(A, n1) == p and partners_of(A, n2) == p)
    n3, n3b = new_session(A), new_session(A); cmd(A, n3, "partnermgr", f"add {n3b}")
    check("N02", "cross-partnership add refused", "already in partnership" in cmd(A, n1, "partnermgr", f"add {n3b}"))
    n4, n5 = new_session(A), new_session(A); cmd(A, n4, "partnermgr", f"add {n5}")
    n6 = new_session(A); cmd(A, n6, "partnermgr", f"add {n5}")
    check("N03", "adopt ungrouped into target's group", partners_of(A, n6) == partners_of(A, n5), (partners_of(A, n6), partners_of(A, n5)))
    nroom = new_session(A); cmd(A, nroom, "roommgr", "create NRoom"); nroomid = room_of(A, nroom)
    check("N04", "add room session refused", "Cannot partner a room session" in cmd(A, n1, "partnermgr", f"add {nroomid}"))
    check("N05", "add self refused", "Cannot partner a session with itself" in cmd(A, n1, "partnermgr", f"add {n1}"))
    check("N06", "remove other dissolves 2-member", "dissolved" in cmd(A, n1, "partnermgr", f"remove {n2}") and partners_of(A, n1) is None)
    check("N08", "remove non-partner refused", "not in a partnership" in cmd(A, n3, "partnermgr", f"remove {new_session(A)}"))
    q1, q2, q3 = new_session(A), new_session(A), new_session(A)
    cmd(A, q1, "partnermgr", f"add {q2}"); cmd(A, q1, "partnermgr", f"add {q3}")
    tk = cmd(A, q1, "partnermgr", f"talk {q2} hello")
    check("N09", "talk to partner delivered", 'state="delivered"' in tk and 'relation="partner"' in tk, tk[:150])
    check("N10", "talk to unrelated refused", "not a related agent" in cmd(A, new_session(A), "partnermgr", f"talk {new_session(A)} hey"))
    check("N11", "broadcast reaches partners", "Broadcast delivered to 2 partners" in cmd(A, q1, "partnermgr", "broadcast everyone"))
    check("N12", "status lists partnership", "count=" in cmd(A, q1, "partnermgr", "status"))

    # ===== C: cross-process =====
    cs = new_session(A)
    lst = get(B, f"/session?directory={D}")
    check("C01", "session created on A visible on B", isinstance(lst, list) and any(s.get("id") == cs for s in lst))
    cb = new_session(A); cmd(A, cb, "roommgr", "create CrossBusy")
    start_shell(A, cb, "sleep 14"); time.sleep(3)
    r = cmd(B, cb, "roommgr", "status")
    check("C02", "cross-process busy refused (lease)", "SessionBusyError" in r or "busy" in r.lower(), r[:140])
    time.sleep(13)
    cr1, cr2 = new_session(A), new_session(A)
    cmd(A, cr1, "roommgr", "create CrossDefer"); crr = room_of(A, cr1)
    cmd(A, cr2, "roommgr", f"join {crr}")
    start_shell(A, cr2, "sleep 14"); time.sleep(3)
    cmd(B, cr1, "roommgr", "post cross-defer"); time.sleep(2)
    check("C03", "cross-process busy: no injection", count(A, cr2, "cross-defer") == 0)
    time.sleep(14)
    check("C03b", "cross-process idle flush", count(A, cr2, "cross-defer") >= 1)

    passed = sum(1 for r in RESULTS if r[2]); total = len(RESULTS)
    print("\n===== SUMMARY %d/%d =====" % (passed, total))
    for cid, name, ok, detail in RESULTS:
        if not ok: print("FAIL", cid, name, "::", str(detail)[:220])
    return 0 if passed == total else 1


if __name__ == "__main__":
    try:
        ensure_servers()
        sys.exit(run())
    finally:
        shutdown()
