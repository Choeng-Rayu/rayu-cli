/**
 * Tracks which tool uses were auto-approved by classifiers.
 * Populated from useCanUseTool.ts and permissions.ts, read from UserToolSuccessMessage.tsx.
 */

import { createSignal } from './signal.js'

type ClassifierApproval = {
  classifier: 'bash' | 'auto-mode'
  matchedRule?: string
  reason?: string
}

const CLASSIFIER_APPROVALS = new Map<string, ClassifierApproval>()
const CLASSIFIER_CHECKING = new Set<string>()
const classifierChecking = createSignal()

export function setClassifierApproval(
  toolUseID: string,
  matchedRule: string,
): void {
  if (!RAYU_FEATURES.BASH_CLASSIFIER) {
    return
  }
  CLASSIFIER_APPROVALS.set(toolUseID, {
    classifier: 'bash',
    matchedRule,
  })
}

export function getClassifierApproval(toolUseID: string): string | undefined {
  if (!RAYU_FEATURES.BASH_CLASSIFIER) {
    return undefined
  }
  const approval = CLASSIFIER_APPROVALS.get(toolUseID)
  if (!approval || approval.classifier !== 'bash') return undefined
  return approval.matchedRule
}

export function setYoloClassifierApproval(
  toolUseID: string,
  reason: string,
): void {
  if (!RAYU_FEATURES.TRANSCRIPT_CLASSIFIER) {
    return
  }
  CLASSIFIER_APPROVALS.set(toolUseID, { classifier: 'auto-mode', reason })
}

export function getYoloClassifierApproval(
  toolUseID: string,
): string | undefined {
  if (!RAYU_FEATURES.TRANSCRIPT_CLASSIFIER) {
    return undefined
  }
  const approval = CLASSIFIER_APPROVALS.get(toolUseID)
  if (!approval || approval.classifier !== 'auto-mode') return undefined
  return approval.reason
}

export function setClassifierChecking(toolUseID: string): void {
  if (!RAYU_FEATURES.BASH_CLASSIFIER && !RAYU_FEATURES.TRANSCRIPT_CLASSIFIER) return
  CLASSIFIER_CHECKING.add(toolUseID)
  classifierChecking.emit()
}

export function clearClassifierChecking(toolUseID: string): void {
  if (!RAYU_FEATURES.BASH_CLASSIFIER && !RAYU_FEATURES.TRANSCRIPT_CLASSIFIER) return
  CLASSIFIER_CHECKING.delete(toolUseID)
  classifierChecking.emit()
}

export const subscribeClassifierChecking = classifierChecking.subscribe

export function isClassifierChecking(toolUseID: string): boolean {
  return CLASSIFIER_CHECKING.has(toolUseID)
}

export function deleteClassifierApproval(toolUseID: string): void {
  CLASSIFIER_APPROVALS.delete(toolUseID)
}

export function clearClassifierApprovals(): void {
  CLASSIFIER_APPROVALS.clear()
  CLASSIFIER_CHECKING.clear()
  classifierChecking.emit()
}
