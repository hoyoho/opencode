import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { usePluginRuntime } from "../../plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const partnership = createMemo(() => {
    const value = session()?.metadata?.partners
    return typeof value === "string" && value.length > 0 ? value : undefined
  })
  const partners = createMemo(() =>
    partnership()
      ? sync.data.session.filter(
          (item) =>
            item.id !== props.sessionID &&
            typeof item.metadata?.partners === "string" &&
            item.metadata.partners === partnership(),
        )
      : [],
  )
  const room = createMemo(() => {
    const value = session()?.metadata?.room
    return typeof value === "string" && value.startsWith("ses") ? value : undefined
  })
  const isRoomSession = createMemo(() => session()?.metadata?.isRoom === true)
  const roomMembers = createMemo(() =>
    room()
      ? sync.data.session.filter((item) => item.id !== props.sessionID && item.metadata?.room === room())
      : [],
  )

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <pluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <text fg={theme.text}>{props.sessionID}</text>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
                <Show when={partnership()}>
                  <text fg={theme.textMuted}>
                    Partners: <span style={{ fg: theme.text }}>{partnership()}</span>{" "}
                    <span>({partners().length})</span>
                  </text>
                  <For each={partners()}>{(item) => <text fg={theme.textMuted}>{item.id}</text>}</For>
                </Show>
                <Show when={isRoomSession()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.info }}>Room</span> <span>({roomMembers().length + 1})</span>
                  </text>
                </Show>
                <Show when={room()}>
                  <text fg={theme.textMuted}>
                    Room: <span style={{ fg: theme.text }}>{room()}</span>{" "}
                    <span>({roomMembers().length})</span>
                  </text>
                  <For each={roomMembers()}>{(item) => <text fg={theme.textMuted}>{item.id}</text>}</For>
                </Show>
              </box>
            </pluginRuntime.Slot>
            <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </pluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
