import { connectionActionPayloadSchema, type ConnectionActionPayload } from "@openwork/types/connection-action-app"
import { mountMcpApp } from "./shared/bridge"
import { AlertIcon, AppHeader, ArrowIcon, CardBody, CardFooter, CheckIcon, KeyValueGrid, PlugIcon, type Tone } from "./shared/ui"
import "./shared/theme.css"

const STATE_PRESENTATION: Record<ConnectionActionPayload["state"], {
  tone: Tone
  badge: string
  title: string
}> = {
  connected: { tone: "success", badge: "Connected", title: "Connection ready" },
  needs_connection: { tone: "warning", badge: "Not connected", title: "Connection needed" },
  reauth_required: { tone: "warning", badge: "Sign-in required", title: "Reconnect needed" },
  provider_error: { tone: "danger", badge: "Provider error", title: "Connection error" },
}

const ACTOR_LABEL: Record<NonNullable<ConnectionActionPayload["actor"]>, string> = {
  member: "You",
  organization_admin: "An organization admin",
  provider_admin: "The provider admin",
  network_admin: "A network admin",
  openwork: "OpenWork support",
}

const SURFACE_LABEL: Record<NonNullable<ConnectionActionPayload["action"]>["surface"], string> = {
  openwork_your_connections: "Your Connections",
  openwork_organization_connections: "Organization Connections",
  provider_admin_console: "Provider admin console",
  network_infrastructure: "Network infrastructure",
  openwork_support: "OpenWork support",
}

mountMcpApp({
  name: "OpenWork Connection Action",
  waitingLabel: "Checking the connection...",
  schema: connectionActionPayloadSchema,
  render: (payload, app) => {
    const presentation = STATE_PRESENTATION[payload.state]
    const actionUrl = payload.action?.url
    const openAction = () => {
      if (actionUrl) void app?.openLink({ url: actionUrl })
    }
    return (
      <main className="card">
        <AppHeader
          tone={presentation.tone}
          icon={payload.state === "connected" ? <CheckIcon /> : payload.state === "provider_error" ? <AlertIcon /> : <PlugIcon />}
          title={presentation.title}
          subtitle={payload.connectionName}
          badge={{ tone: presentation.tone, label: presentation.badge }}
        />
        <CardBody>
          <p className="name">{payload.connectionName}</p>
          <p className="description">{payload.message}</p>
          {payload.action ? (
            <KeyValueGrid
              items={[
                ...(payload.actor ? [{ label: "Who acts", value: ACTOR_LABEL[payload.actor] }] : []),
                { label: "Where", value: SURFACE_LABEL[payload.action.surface] },
              ]}
            />
          ) : null}
        </CardBody>
        <CardFooter
          footnote={payload.state === "connected"
            ? "Tools from this connection are available in chat right now."
            : "After it is fixed, ask again in this chat — the agent searches live."}
          action={payload.action ? (
            actionUrl ? (
              <button className="action-primary" type="button" onClick={openAction}>
                {payload.action.label} <ArrowIcon />
              </button>
            ) : (
              <span className="badge" data-tone={presentation.tone}>{payload.action.label}</span>
            )
          ) : undefined}
        />
      </main>
    )
  },
})
