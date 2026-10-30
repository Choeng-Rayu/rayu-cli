/**
 * The Studio Remote and GitHub cards of Settings → Integrations, as views. Pure: the
 * host passes in what it knows (the bridge's state, the pending pairing, the workspace)
 * and the file check, so every case is testable.
 */
import { join } from 'node:path'

import {
  RAYU_ASSISTANT_WORKFLOW_PATH,
  RAYU_REVIEW_WORKFLOW_PATH,
} from '../../../constants/github-app.js'
import type { GitHubIntegrationView, WebBridgeView } from '../../shared/settingsProtocol.js'

export interface WebBridgeFacts {
  /** The running bridge's connection state, or null when none is running. */
  bridgeState: string | null
  /** A guest pairing in progress (`guestPairingStatus()`), or null. */
  pairing: { status: string; error?: string } | null
  signedIn: boolean
}

export function webBridgeView({ bridgeState, pairing, signedIn }: WebBridgeFacts): WebBridgeView {
  if (bridgeState !== null) {
    switch (bridgeState) {
      case 'connected':
        return { status: 'connected', detail: null, signedIn }
      case 'reconnecting':
        return { status: 'reconnecting', detail: 'The connection dropped; reconnecting.', signedIn }
      case 'error':
        return { status: 'error', detail: 'Studio Remote could not connect.', signedIn }
      default:
        // idle, connecting, registering: on its way up.
        return { status: 'connecting', detail: null, signedIn }
    }
  }
  if (pairing?.status === 'starting') return { status: 'pairing', detail: 'Creating a pairing QR code…', signedIn }
  if (pairing?.status === 'waiting') return { status: 'pairing', detail: 'Scan the QR code in the pairing tab, then approve this machine in Studio.', signedIn }
  if (pairing?.status === 'error') return { status: 'error', detail: pairing.error ?? 'Studio pairing failed.', signedIn }
  return { status: 'off', detail: null, signedIn }
}

const WORKFLOWS = [
  { id: 'rayu', label: 'Rayu assistant (@rayu in issues and pull requests)', path: RAYU_ASSISTANT_WORKFLOW_PATH },
  { id: 'rayu-review', label: 'Rayu pull-request review', path: RAYU_REVIEW_WORKFLOW_PATH },
] as const

/** Which of Rayu's workflows this workspace already has. */
export function githubIntegrationView(
  workspaceDir: string | undefined,
  exists: (path: string) => boolean,
): GitHubIntegrationView {
  return {
    hasWorkspace: workspaceDir !== undefined,
    workflows: WORKFLOWS.map(workflow => ({
      ...workflow,
      installed: workspaceDir !== undefined && exists(join(workspaceDir, workflow.path)),
    })),
  }
}
