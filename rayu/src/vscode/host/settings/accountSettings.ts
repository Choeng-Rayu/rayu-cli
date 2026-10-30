/**
 * The Settings tab's Account section: when to read the account, and what the tab is told.
 *
 * Reading the account is three network requests, so it happens only when someone looks:
 * when the section is opened (at most once a minute), when the user asks, and when the
 * sign-in changes while the section has been loaded. The view itself is built by
 * `account/accountService.ts`.
 *
 * Free of `vscode` imports.
 */
import type { AccountSectionView, AccountView } from '../../shared/settingsProtocol.js'

/** How old a loaded account may be before opening the section reads it again. */
export const ACCOUNT_MAX_AGE_MS = 60_000

export class AccountSettings {
  private view: AccountSectionView = { status: 'idle', account: null, error: null, updatedAt: null }
  private inFlight: Promise<void> | null = null
  /** A refresh asked for while one was running: run once more, since its answer may be stale. */
  private again = false

  constructor(
    private readonly load: () => Promise<AccountView>,
    private readonly publish: (view: AccountSectionView) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): AccountSectionView {
    return this.view
  }

  refresh(): Promise<void> {
    if (this.inFlight) {
      this.again = true
      return this.inFlight
    }
    this.inFlight = this.run().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** Read the account if it was never read, or was read more than `maxAgeMs` ago. */
  refreshIfStale(maxAgeMs = ACCOUNT_MAX_AGE_MS): Promise<void> {
    const { updatedAt } = this.view
    if (this.inFlight || (updatedAt !== null && this.now() - updatedAt < maxAgeMs)) {
      return this.inFlight ?? Promise.resolve()
    }
    return this.refresh()
  }

  /** The sign-in changed. Re-read only a section that has been shown, to avoid needless requests. */
  sessionChanged(): Promise<void> {
    return this.view.status === 'idle' ? Promise.resolve() : this.refresh()
  }

  private async run(): Promise<void> {
    do {
      this.again = false
      this.set({ status: 'loading', error: null })
      try {
        const account = await this.load()
        this.set({ status: 'ready', account, error: null, updatedAt: this.now() })
      } catch (cause) {
        // The sources report their own failures; reaching here is unexpected.
        console.warn('[rayucode] could not load the Rayu account:', cause)
        this.set({ status: 'ready', error: 'Could not load your Rayu account.' })
      }
    } while (this.again)
  }

  private set(patch: Partial<AccountSectionView>): void {
    this.view = { ...this.view, ...patch }
    this.publish(this.view)
  }
}
