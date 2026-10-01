# 协作管理命令：用户操作语义（rooms / partnerships）

本文档定义「用户手打管理命令」时的行为契约，供后续实现/修复使用。
相关代码位于 `packages/opencode/src/session/prompt.ts`、`packages/opencode/src/tool/room.ts`、
`packages/opencode/src/tool/partner.ts`。

## 术语

- **用户操作**：用户在某个 session 的输入框里手打 `/roommgr ...` 或 `/partnermgr ...`
  （`SessionPrompt.command` → `managerCommand`）。
- **agent 操作**：模型自己调用 `room` / `partner` 工具（走正常工具调用）。
- **动作（action）**：用户敲的那条命令本身（`/roommgr invite ses_xxx`）。
- **结果（result）**：动作造成的状态变化或事件，例如房间的 `<room_event>`、
  伙伴的 `<partnership_event>`、`say` 的消息内容、成员关系变化。
- **ignored**：part 上带 `ignored: true`。`message-v2.ts` 的 `toModelMessagesEffect`
  会跳过它，所以模型不可见、不消耗 token，但 TUI 仍然显示。
- **queue**：目标 session 正忙时，消息被 `deliver()` 立即 admit 进它的会话
  （`noReply`），在它的对话流里显示为排队中，等当前 turn 到边界再处理。
- **时间戳**：面向模型的 room/partner 消息与事件都带 `at`（UTC ISO 8601），
  与房间的 `at` 一致，便于同一 turn 内批量到达的多条消息判断先后。

## 总原则

1. **管理命令永不因 busy 被拒绝，也永不打断正在运行的 turn。** 只有 ESC（`session.abort`）
   可以打断 turn。
2. **用户操作永远不写 assistant 回执**。动作对模型不可见；只有结果按分组规则决定可见性。
3. **用户命令本身不写入任何会话**（不显示命令行 echo）。这样 TUI 不会出现一条被当作
   普通用户消息、与效果错序、或被标记 QUEUED 的命令行。
4. 只有 **agent 操作**（E 组）才需要工具回执，结果照常对模型可见。

## 分组总览

| 组 | 命令 | busy 行为 | 打断 | 动作可见 | 结果可见 | 唤醒 |
| --- | --- | --- | --- | --- | --- | --- |
| A | `/partnermgr broadcast`、`/roommgr say\|post` | 立即投递（目标 busy 排队） | 否 | 否（不写入） | 是（消息内容） | idle 目标唤醒 |
| B | `/roommgr new\|join\|invite\|kick\|close\|open\|destroy\|leave` | 立即生效 | 否 | 否（不写入） | 是（事件，非 ignored） | 否（只通知） |
| C | `/partnermgr add\|remove\|leave` | 立即生效（同 B） | 否 | 否 | 是（事件） | 否（只通知） |
| D | `/roommgr status`、`/partnermgr status` | 立即返回 | 否 | 否 | ignored 结果（例外，见 D） | — |
| E | 模型自己调用 `room`/`partner` 工具 | 正常工具调用 | — | 可见 | 工具结果可见 | 按工具既有规则 |

---

## A 组：用户手打·消息类

命令：`/partnermgr broadcast <msg>`、`/roommgr say <msg>`（`post` 同义）。

规则：

1. **命令本身不写入会话**；也**不写任何 assistant 回执**。
2. **`broadcast`**：把 `<broadcast sender="user">...` 投递给 partnership 的
   **所有会话，包含发起者自己**。
3. **`say` / `post`**：立即往 room 追加一条用户消息；房间所有成员收到。
4. **投递目标**：
   - idle → 立即唤醒（wake）。
   - busy → 立即 admit 到目标会话，显示 **queue 标记**，在它当前 turn 的边界被处理。
5. 被投递进去的广播/发言内容为**非 ignored**，模型可见（这是要 queue 给 agent 的内容）。

## B 组：用户手打·房间状态修改

命令：`/roommgr new|join|invite|kick|close|open|destroy|leave`。

规则：

1. **busy 时也立即生效，不打断 turn**；命令本身不写入会话，也不写回执。
2. **结果可见**：房间事件（`<room_event>`：created/joined/kicked/left/closed/opened）
   以**非 ignored** 消息投递给相关成员，模型可见。
3. **`invite` / `kick`**：对被操作的目标 session **只通知，不唤醒**。
4. **离开类**（`room leave`、`room destroy`、`partner leave`、`partner remove`）：
   除给其他成员广播事件外，额外给**离开/被移除的那个 session 自己**投递一条**非 ignored** 通知：
   - `<room_notice room="ses_...">You left room ses_....</room_notice>`
   - `<partnership_notice partnership="prt-...">You left partnership prt-....</partnership_notice>`
   - 只通知，**不唤醒**。
   - `room destroy` 会清空所有成员，因此**每个被清空的成员**都收到通知。
5. **B5**：事件对模型可见，但**不主动唤醒**。因此：
   - idle 成员：消息留在上下文里，不引发回复；
   - busy 成员：在其 turn 到边界时会读到事件并**可能回复**（消耗 token）——这是预期行为。

## C 组：用户手打·伙伴状态修改

命令：`/partnermgr add|remove|leave`。与 B 组同构：

1. busy 时立即生效、不打断、无回执；命令本身不写入会话。
2. 结果（`<partnership_event>`：joined/left/removed）以**非 ignored** 消息投递，模型可见。
3. `add <session>`：通知 partnership **所有成员**（含发起者与被加入者）；对被加入的目标
   **只通知不唤醒**。
4. `remove <session>`：给**被移除者**一条非 ignored 通知（“You were removed ...”），
   给其余成员 “X was removed” 事件；只通知不唤醒。
5. `leave`：给**离开者**一条非 ignored 通知（“You left ...”），给其余成员 “X left” 事件；
   只通知不唤醒。
6. **自动解散**（partnership 掉到 1 人）：给最后剩下的成员一条非 ignored 的
   “partnership dissolved” 通知；只通知不唤醒。

## D 组：用户手打·查询

命令：`/roommgr status`、`/partnermgr status`。

- 纯查询：无副作用、不唤醒、不打断、模型不可见。
- **总原则 2 的唯一例外**：查询必须把结果给用户看，所以写一条 `ignored` 结果消息
  （持久化、TUI-only、模型不可见、不耗 token）。命令本身不写入。
  - 状态修改/消息类命令无输出；查询类有（`ignored`）结果。

## E 组：agent 自己调用工具

- 正常工具调用：工具结果作为 tool result 回给模型，动作与结果对模型均可见。
- agent 发起的投递（room post / partner talk|broadcast / 成员事件）沿用同一套投递规则：
  - 消息类：内容非 ignored、idle 目标唤醒、busy 排队；
  - 状态修改类：事件非 ignored、只通知不唤醒。
- 即 E 组与用户操作（A/B/C/D）的唯一区别是「谁发起」：用户发起的命令动作 `ignored`、无回执；
  agent 发起的动作本身就是模型行为，正常可见。两者共用 `deliver()` 投递管线。

## 横切设计

### X1. 纯 ignored 的 user 消息不参与 `lastUser`

- 目的：仅给 TUI 看的 `ignored` 消息若能成为 loop 的 `lastUser`，会**凭空触发一轮模型调用**
  （违反“不消耗 token”）。
- 实现：`packages/opencode/src/session/message-v2.ts` 的 `latest()` 选择 `user` 时，
  跳过「没有任何有效 part」的 user 消息。有效 part = 非 `ignored` 的非空 text、file、agent、
  compaction、subtask 等；一条只有 `ignored` text 的 user 消息属于纯展示，跳过。
  与 `toModelMessagesEffect` 跳过 ignored text 的行为保持一致。
- 边界：若跳过导致 `user` 为 undefined（整个会话只有 ignored 消息），`runLoop` 本不应被触发；
  实现时加防御，避免抛 “No user message found”。

### X2. queue 标记

- 目标 busy 时被 admit 的消息要在其对话流显示 QUEUED。
- 机制：`packages/tui/src/routes/session/index.tsx` 中
  `pending` = 最后一条未完成 assistant 的索引，
  `queued = props.pending !== undefined && props.index > props.pending`，渲染为 ` QUEUED ` 徽标。
  被 `deliver()` admit 的 user 消息位于运行中的 assistant 之后，因此显示为 QUEUED。

---

## 实现要点

### 1. `packages/opencode/src/session/prompt.ts` — `managerCommand`

- 用户操作**不写 assistant 回执，也不写命令行**。
- `status` 查询和失败（含 parser error）除外：写一条 `ignored` 结果（assistant 消息）给用户看。
- 无论 busy 与否都执行工具；不在 `managerCommand` 里检查 `assertNotBusy`/`foreignHeld`。
- 成功的状态/消息操作返回一个**不落库**的 `WithParts`（`directReply` 的 `persist: false`），
  仅用于 HTTP 返回；TUI 命令路径忽略返回值。

### 2. `packages/opencode/src/session/message-v2.ts` — `latest()`

- **纯 `ignored` 的 user 消息不参与 `lastUser`**，否则命令 echo / 通知会凭空触发一轮模型调用
  （违反「不消耗 token」）。
- 判定：一条 user 消息若没有任何有效 part（有效 = 非 `ignored` 的非空 text、file、agent、
  compaction、subtask 等）则跳过；无 part 的消息保持原行为。
- 与 `toModelMessagesEffect` 跳过 ignored text 的行为保持一致。
- 检查点：`prompt.ts` 的 `runLoop` 依赖 `MessageV2.latest(msgs)` 决定 `lastUser`。

### 3. `packages/opencode/src/tool/room.ts`

- 用户发起的房间事件（joined/kicked/left/created/closed/opened）**非 ignored**（模型可见）。
- `invite` / `kick`：给目标一条非 ignored 通知，**不唤醒**。
- `leave`：给离开者一条非 ignored 通知（`<room_notice>`），**不唤醒**。
- `destroy`：给每个被清空成员一条非 ignored 通知，**不唤醒**。

### 4. `packages/opencode/src/tool/partner.ts`

- 成员事件（joined/left/removed/dissolved）**非 ignored**，**只通知不唤醒**。
- `add`：通知所有成员（含发起者与被加入者）。
- `remove` / `leave`：给离开/被移除者一条非 ignored 通知。
- 自动解散：给最后剩下的成员一条非 ignored 通知。
- `broadcast`：投递集合包含发起者；广播内容非 ignored。

### 5. TUI

- 命令错误以 toast 呈现（`component/prompt/index.tsx` 的 `session.command(...)` 需 `.catch`）。
- queue 标记：`routes/session/index.tsx` 用 `pending` + `index > pending` 渲染 ` QUEUED `。
- 侧栏：打开 room 会话时用 room session id 过滤显示成员。

---

## 验收

- A：`say`/`broadcast` 在 busy 时执行投递、不写 assistant 回执；idle 目标被唤醒；
  广播包含发起者；被投递内容对模型可见。
- B/C：`invite`/`kick`/`leave`/`destroy`/`add`/`remove` 在 busy 时生效且不打断；
  事件对模型可见；离开/被移除/被清空者收到自己的非 ignored 通知；目标只通知不唤醒。
- D：`status` 返回 `ignored` 结果。
- `latest()` 跳过纯 ignored user 消息，不触发额外模型轮次。
