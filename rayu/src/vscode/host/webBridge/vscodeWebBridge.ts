import { createHash } from 'node:crypto'
import { getRayuApiBaseUrl } from '../../../services/rayuAuth/rayuSession.js'
import { getRayuConfigHomeDir } from '../../../utils/envUtils.js'
import { getWebBridgeToken } from '../../../webBridge/guestPairing.js'
import {
  WebBridgeClient,
  WebBridgePermissionRelay,
  resolveHostname,
  resolveMachineId,
  type WebBridgeConnectionState,
} from '../../../webBridge/client/index.js'
import {
  approvalKind,
  resolveApprovalDecision,
  sendApproval,
  type WebBridgeApprovalRequest,
} from '../../../webBridge/webBridgeApprovals.js'
import type { InboundControlRequest } from '../engine/controlClient.js'
import type { PermissionRouter } from '../panel/permissionRouter.js'
import type { ChatSession } from '../panel/sessionHandle.js'
import type { TranscriptEntry } from '../../shared/webviewProtocol.js'

/** A workspace-specific id prevents the CLI and editor from replacing each other's socket. */
export function vscodeBridgeMachineId(cwd: string): string {
  const install = resolveMachineId(getRayuConfigHomeDir())
  const workspace = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return `${install.slice(0, 24)}-vscode-${workspace}`
}

export class VSCodeWebBridge {
  private readonly client: WebBridgeClient
  private readonly relay: WebBridgePermissionRelay
  private readonly streamedEntryIds = new Set<string>()

  constructor(
    private readonly session: ChatSession,
    private readonly permissions: PermissionRouter,
    cwd: string,
    onState: (state: WebBridgeConnectionState) => void,
  ) {
    this.client = new WebBridgeClient({
      apiBaseUrl: getRayuApiBaseUrl(),
      getToken: getWebBridgeToken,
      hello: {
        machineId: vscodeBridgeMachineId(cwd),
        hostname: resolveHostname(),
        cwd,
        pid: process.pid,
        sessionLabel: `Rayucode VS Code — ${cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'}`,
      },
      handlers: {
        onPrompt: prompt => {
          // The approved bridge socket authenticates this remote prompt only.
          // submitPrompt marks it bridge-origin; local editor prompts retain the
          // normal sign-in gate. The bridge JWT cannot access hosted inference.
          void this.session.submitPrompt(prompt.text, [], 'normal', true).catch(error => {
            this.client.activity({ kind: 'error', summary: error instanceof Error ? error.message : 'Prompt failed' })
            this.client.streamEnd({ finishReason: 'error' })
          })
        },
        onDecision: decision => this.relay.handleDecision(decision),
        onInterrupt: () => {
          void this.session.interrupt().finally(() => this.client.interruptAck())
        },
        onConnectionChange: state => {
          if (state === 'error' || state === 'reconnecting') this.relay.clear()
          onState(state)
        },
      },
    })
    this.relay = new WebBridgePermissionRelay(this.client)
  }

  async connect(): Promise<boolean> {
    return this.client.connect()
  }

  stop(): void {
    this.relay.clear()
    this.client.stop()
  }

  get state(): WebBridgeConnectionState {
    return this.client.connectionState
  }

  onPartial(id: string, kind: 'text' | 'thinking', delta: string): void {
    this.streamedEntryIds.add(id)
    if (this.streamedEntryIds.size > 256) this.streamedEntryIds.delete(this.streamedEntryIds.values().next().value!)
    this.client.streamDelta(delta, kind)
  }

  onTurnState(running: boolean): void {
    if (!running) this.client.streamEnd()
  }

  onEntry(entry: TranscriptEntry): void {
    if (entry.kind === 'prompt' || !('text' in entry) || typeof entry.text !== 'string') return
    if (entry.kind === 'assistant' && entry.streaming) return
    if (this.streamedEntryIds.delete(entry.id)) return
    this.client.activity({ kind: entry.kind, summary: entry.text })
  }

  onPermissionRequest(request: InboundControlRequest): void {
    if (request.subtype !== 'can_use_tool') return
    const raw = request.request
    const requestId = request.requestId
    const input = raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input)
      ? raw.input as Record<string, unknown>
      : {}
    const approval: WebBridgeApprovalRequest = {
      requestId,
      toolName: typeof raw.tool_name === 'string' ? raw.tool_name : 'tool',
      input,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.tool_use_id === 'string' ? { toolUseId: raw.tool_use_id } : {}),
      ...(Array.isArray(raw.permission_suggestions)
        ? { permissionSuggestions: raw.permission_suggestions }
        : {}),
      ...(typeof raw.blocked_path === 'string' ? { blockedPath: raw.blocked_path } : {}),
    }
    // Same card and same answer handling as the CLI worker; see webBridgeApprovals.ts.
    const kind = approvalKind(approval)
    this.relay.onResponse(requestId, decision => {
      const response = resolveApprovalDecision(kind, approval, decision)
      // Unusable answers leave the editor's own card up — it is still authoritative.
      if (!response) return
      const control = this.session.controlClient
      if (!control?.isAwaitingResponse(requestId)) return
      this.permissions.dismiss(requestId)
      control.respond(requestId, response.behavior === 'allow'
        ? {
            behavior: 'allow',
            // REQUIRED by the engine's schema; see permissionRouter.ts.
            updatedInput: response.updatedInput ?? input,
            decisionClassification: 'user_temporary',
            ...(response.updatedPermissions?.length
              ? { updatedPermissions: response.updatedPermissions }
              : {}),
          }
        : {
            behavior: 'deny',
            message: response.message || 'The user declined from Studio.',
            decisionClassification: 'user_reject',
          })
    })
    sendApproval(this.relay, kind, approval)
  }

  onPermissionDismiss(requestId: string): void {
    this.relay.cancel(requestId)
  }
}
