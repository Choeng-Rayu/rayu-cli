/**
 * Settings → Account: who is signed in, the plan, credits and limits, and this month's
 * feature usage — read from Rayu by the host, which never sends a token here.
 *
 * Presentational only: actions and links are reported by NAME and the host decides
 * what they do, so this page cannot be made to open an arbitrary URL.
 */
import type {
  AccountActionId,
  AccountLinkId,
  AccountSectionView,
  AccountUsageView,
  CreditWindowView,
  DeviceView,
  FeatureUsageView,
} from '../../shared/settingsProtocol.js'
import { SettingsItem } from './SettingsItem.js'

export interface AccountSectionProps {
  account: AccountSectionView
  onRefresh: () => void
  onAction: (action: AccountActionId) => void
  onOpenLink: (link: AccountLinkId) => void
  onRemoveDevice: (deviceId: string) => void
}

const count = (value: number): string => value.toLocaleString('en-US')

/** "$20 / month", or "Free" for a plan without a price. */
export function formatPlanPrice(priceCents: number): string {
  if (priceCents <= 0) return 'Free'
  const dollars = priceCents / 100
  return `$${dollars.toFixed(priceCents % 100 === 0 ? 0 : 2)} / month`
}

export function formatDay(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatResets(epochMs: number | null): string {
  if (epochMs === null) return ''
  const when = new Date(epochMs).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  return ` · resets ${when}`
}

const WINDOW_LABELS: Record<CreditWindowView['id'], string> = { session: 'Session', weekly: 'This week' }

export function AccountSection(props: AccountSectionProps): JSX.Element {
  const { account: section, onRefresh } = props
  const { account } = section
  if (!account) {
    return section.error
      ? <ErrorNotice message={section.error} onRetry={onRefresh} />
      : <p className="rs-loading" role="status">Loading your account…</p>
  }
  switch (account.kind) {
    case 'disabled':
      return <p className="rs-value">Rayu accounts are turned off in this build of Rayucode.</p>
    case 'signedOut':
      return <SignedOut {...props} apiKey={false} />
    case 'apiKey':
      return <SignedOut {...props} apiKey />
    case 'signedIn':
      return (
        <>
          {section.error && <ErrorNotice message={section.error} onRetry={onRefresh} />}
          <SettingsItem label="Signed in as">
            <span className="rs-value">{account.identity.displayName ?? account.identity.email ?? 'Rayu account'}</span>
            {account.identity.displayName && account.identity.email && (
              <span className="rs-item-note">{account.identity.email}</span>
            )}
            {!account.identity.active && (
              <span className="rs-warning" role="alert">Rayu reports this account as not active. Contact Rayu support.</span>
            )}
          </SettingsItem>
          {account.usage.ok
            ? <UsageItems usage={account.usage.value} onOpenLink={props.onOpenLink} />
            : <ErrorNotice message={account.usage.error} onRetry={onRefresh} />}
          {account.features.ok
            ? <FeaturesItem features={account.features.value} />
            : <ErrorNotice message={account.features.error} onRetry={onRefresh} />}
          {account.devices.ok
            ? <DevicesItem devices={account.devices.value} onRemove={props.onRemoveDevice} />
            : <ErrorNotice message={account.devices.error} onRetry={onRefresh} />}
          <div className="rs-actions">
            <button type="button" className="rs-button rs-button-secondary" onClick={onRefresh} disabled={section.status === 'loading'}>
              {section.status === 'loading' ? 'Refreshing…' : 'Refresh'}
            </button>
            <button type="button" className="rs-button rs-button-secondary" onClick={() => props.onAction('signOut')}>
              Sign out
            </button>
          </div>
        </>
      )
  }
}

function SignedOut({ apiKey, onAction, onOpenLink }: AccountSectionProps & { apiKey: boolean }): JSX.Element {
  return (
    <>
      <p className="rs-value">
        {apiKey
          ? 'Rayucode is using a Rayu API key. Sign in with your Rayu account to see your plan, credits and usage here.'
          : 'Sign in to see your plan, credits and usage.'}
      </p>
      <div className="rs-actions">
        <button type="button" className="rs-button" onClick={() => onAction('signIn')}>Sign in</button>
        {apiKey
          ? <button type="button" className="rs-button rs-button-secondary" onClick={() => onOpenLink('apiKeys')}>Manage API keys</button>
          : <button type="button" className="rs-button rs-button-secondary" onClick={() => onAction('useApiKey')}>Use an API key</button>}
      </div>
    </>
  )
}

function UsageItems({ usage, onOpenLink }: { usage: AccountUsageView; onOpenLink: (link: AccountLinkId) => void }): JSX.Element {
  return (
    <>
      <SettingsItem label="Plan">
        <span className="rs-value">{usage.planName} · {formatPlanPrice(usage.priceCents)}</span>
        {usage.renewsAt && <span className="rs-item-note">Renews {formatDay(usage.renewsAt)}</span>}
        <LinkRow links={[['plan', 'Manage plan'], ['plans', 'Compare plans'], ['billing', 'Billing']]} onOpenLink={onOpenLink} />
      </SettingsItem>
      <SettingsItem label="Credits" description={usage.team ? 'Your share of your team\'s allowance.' : undefined}>
        {usage.credits
          ? <Meter label="This period" used={usage.credits.used} cap={usage.credits.perPeriod} note={`${count(usage.credits.remaining)} left`} />
          : <span className="rs-value">This plan includes no hosted credits.</span>}
        {usage.pacing.enforced && usage.pacing.windows.map(window => (
          <Meter
            key={window.id}
            label={WINDOW_LABELS[window.id]}
            used={window.used}
            cap={window.cap}
            note={`${count(Math.max(0, window.cap - window.used))} left${formatResets(window.resetsAt)}`}
          />
        ))}
        {!usage.pacing.enforced && usage.pacing.windows.length > 0 && (
          <span className="rs-item-note">Pacing is off: you can use all your credits without session or weekly limits.</span>
        )}
        {usage.pacing.advice && <span className="rs-warning" role="status">{usage.pacing.advice}</span>}
        {usage.dailyTurns && (
          <Meter
            label="Turns today"
            used={usage.dailyTurns.used}
            cap={usage.dailyTurns.max}
            note={`${count(usage.dailyTurns.remaining)} left${formatResets(usage.dailyTurns.resetsAt)}`}
          />
        )}
        {usage.topUpBalance !== null && <span className="rs-value">Top-up balance: {count(usage.topUpBalance)} credits</span>}
        <LinkRow
          links={[
            ['usage', 'Usage details'],
            ...(usage.topUpBalance !== null ? [['credits', 'Buy credits'] as const] : []),
            ...(usage.pacing.windows.length > 0 && !usage.team ? [['dashboard', 'Pacing settings'] as const] : []),
          ]}
          onOpenLink={onOpenLink}
        />
      </SettingsItem>
    </>
  )
}

function FeaturesItem({ features }: { features: FeatureUsageView[] }): JSX.Element | null {
  if (features.length === 0) return null
  return (
    <SettingsItem label="This month" description="Features your plan meters, counted per calendar month (UTC).">
      {features.map(feature => feature.limit === null
        ? <span key={feature.key} className="rs-value">{feature.label}: {count(feature.used)} used · unlimited</span>
        : <Meter key={feature.key} label={feature.label} used={feature.used} cap={feature.limit} note={`${count(Math.max(0, feature.limit - feature.used))} left`} />)}
    </SettingsItem>
  )
}

const PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

export function describeDevice(device: DeviceView): string {
  const platform = PLATFORM_NAMES[device.platform] ?? device.platform
  const seen = device.status === 'online' ? 'Online now' : device.lastSeenAt ? `Last seen ${formatDay(device.lastSeenAt)}` : device.status
  return `${platform} · ${device.arch} · Rayu ${device.version} · ${seen}`
}

function DevicesItem({ devices, onRemove }: { devices: DeviceView[]; onRemove: (deviceId: string) => void }): JSX.Element {
  return (
    <SettingsItem label="Devices" description="Machines where the Rayu CLI is signed in to this account. Telegram and the Mini App use this list.">
      {devices.length === 0 && <span className="rs-value">No devices yet.</span>}
      {devices.map(device => (
        <div key={device.deviceId} className="rs-device">
          <div className="rs-device-text">
            <span className="rs-value">
              {device.name}
              {device.thisMachine && <span className="rs-badge">This machine</span>}
            </span>
            <span className="rs-item-note">{describeDevice(device)}</span>
          </div>
          <button type="button" className="rs-button rs-button-secondary" onClick={() => onRemove(device.deviceId)}>
            Remove
          </button>
        </div>
      ))}
    </SettingsItem>
  )
}

export function Meter({ label, used, cap, note }: { label: string; used: number; cap: number; note: string }): JSX.Element {
  const ratio = cap > 0 ? Math.min(1, Math.max(0, used / cap)) : 0
  return (
    <div className="rs-meter">
      <div className="rs-meter-label">
        <span>{label}</span>
        <span>{count(used)} / {count(cap)}</span>
      </div>
      <div
        className={`rs-meter-track${ratio >= 1 ? ' rs-meter-full' : ''}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(used, cap)}
      >
        <div className="rs-meter-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <span className="rs-item-note">{note}</span>
    </div>
  )
}

function LinkRow({ links, onOpenLink }: { links: ReadonlyArray<readonly [AccountLinkId, string]>; onOpenLink: (link: AccountLinkId) => void }): JSX.Element {
  return (
    <div className="rs-links">
      {links.map(([id, text]) => (
        <button key={id} type="button" className="rs-link" onClick={() => onOpenLink(id)}>{text}</button>
      ))}
    </div>
  )
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="rs-error" role="alert">
      <span>{message}</span>
      <button type="button" className="rs-button rs-button-secondary" onClick={onRetry}>Retry</button>
    </div>
  )
}
