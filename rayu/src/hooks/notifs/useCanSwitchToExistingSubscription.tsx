import { useStartupNotification } from './useStartupNotification.js'

/**
 * Claude account subscription prompts are disabled in Rayu-only auth mode.
 * Keep the hook as a no-op so existing startup notification wiring remains stable.
 */
export function useCanSwitchToExistingSubscription(): void {
  useStartupNotification(async () => null)
}
