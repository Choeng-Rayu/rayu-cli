import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { toString as qrToString } from 'qrcode'
import { Select } from '../../components/CustomSelect/select.js'
import type { OptionWithDescription } from '../../components/CustomSelect/select.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { fetchRayuCredits } from '../../services/rayuAuth/rayuCredits.js'
import {
  cancelTopupPurchase,
  clampTopupCredits,
  createTopupPurchase,
  fetchTopupPaymentStatus,
  fetchTopupQuote,
  formatTopupRate,
  formatUsd,
  isTopupError,
  previewAmountCents,
  suggestedTopupAmounts,
  type TopupMethod,
  type TopupPurchase,
  type TopupQuote,
} from '../../services/rayuAuth/rayuTopup.js'
import { hasRayuSession } from '../../services/rayuAuth/rayuSession.js'
import { openBrowser } from '../../utils/browser.js'

/**
 * How often the pending purchase is polled. The backend's Bakong poll is what
 * actually confirms the payment, so this only needs to be responsive to a human
 * finishing a wallet transfer — not tight.
 */
const POLL_INTERVAL_MS = 3000

/** Payment rails offered, in the order a Cambodian user most likely wants them. */
const RAIL_OPTIONS: { value: TopupMethod; label: string; description: string }[] = [
  { value: 'aba', label: 'ABA', description: 'Scan with ABA Mobile' },
  { value: 'bakong', label: 'Bakong KHQR', description: 'Any KHQR-capable wallet' },
  // Opens a hosted Stripe Checkout page in the user's browser. The server
  // answers 501 until the card rail is enabled, and that message is shown
  // verbatim — so the option is always visible (not gated behind a feature
  // probe) and the failure is explicit and actionable.
  { value: 'stripe', label: 'Card (Stripe)', description: 'Pay by card in your browser' },
]

type Phase = 'loading' | 'amount' | 'method' | 'pay' | 'done'

/** Render a KHQR payload as terminal-drawable ASCII. */
async function renderQr(payload: string): Promise<string> {
  return qrToString(payload, { type: 'terminal', small: true, errorCorrectionLevel: 'L' })
}

function TopupFlow({
  onDone,
  initialCredits,
}: {
  onDone: (result?: string) => void
  initialCredits?: number
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>('loading')
  const [quote, setQuote] = useState<TopupQuote | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [credits, setCredits] = useState<number | null>(null)
  const [purchase, setPurchase] = useState<TopupPurchase | null>(null)
  const [qrArt, setQrArt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [waited, setWaited] = useState(0)
  const finished = useRef(false)

  /** Resolve the command exactly once (paid, failed, or esc-cancelled). */
  const finish = (result: string): void => {
    if (finished.current) return
    finished.current = true
    onDone(result)
  }

  // Load the live quote + the user's current balance. Both come from the
  // server; nothing about the price is decided here.
  useEffect(() => {
    let alive = true
    void (async () => {
      const [q, creditStatus] = await Promise.all([
        fetchTopupQuote(initialCredits),
        fetchRayuCredits(),
      ])
      if (!alive) return
      if (creditStatus) setBalance(creditStatus.topupBalance)
      if (!q) {
        finish(
          'Could not load top-up pricing right now. Check your connection and try /topup again.',
        )
        return
      }
      setQuote(q)
      if (!q.enabled) {
        finish('Credit top-up is not enabled on this server.')
        return
      }
      // An amount passed as `/topup 5000` skips the picker, clamped to the
      // server's own bounds so it can only ever be a payable amount.
      if (initialCredits != null) {
        setCredits(clampTopupCredits(initialCredits, q))
        setPhase('method')
      } else {
        setPhase('amount')
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll the pending purchase until it is paid, expires, or is cancelled.
  useEffect(() => {
    if (phase !== 'pay' || !purchase) return
    let alive = true
    const timer = setInterval(() => {
      void (async () => {
        const status = await fetchTopupPaymentStatus(purchase.paymentId)
        if (!alive) return
        setWaited((w) => w + POLL_INTERVAL_MS)
        // A transient failure yields null — keep polling rather than giving up.
        if (!status) return
        if (status.status === 'paid') {
          setPhase('done')
          // Re-read the balance from the server so the total shown is the real
          // one, not a locally added number.
          const fresh = await fetchRayuCredits()
          const granted = status.credits ?? purchase.credits
          const total = fresh ? fresh.topupBalance : null
          finish(
            total != null
              ? `Payment received — ${granted.toLocaleString()} credits added. Top-up balance: ${total.toLocaleString()} credits.`
              : `Payment received — ${granted.toLocaleString()} credits added.`,
          )
          return
        }
        if (status.status === 'expired' || status.status === 'canceled') {
          setPhase('done')
          finish(
            `This QR ${status.status === 'expired' ? 'expired' : 'was canceled'} before payment. Run /topup to start a new one.`,
          )
        }
      })()
    }, POLL_INTERVAL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, purchase])

  // Esc abandons the flow. A pending QR is cancelled server-side so it is not
  // reused (or alert-matched) after the user walked away.
  useKeybinding(
    'confirm:no',
    () => {
      if (purchase && phase === 'pay') {
        void cancelTopupPurchase(purchase.paymentId)
        finish('Top-up canceled.')
        return
      }
      finish('Top-up canceled.')
    },
    { context: 'Confirmation' },
  )

  const startPurchase = (method: TopupMethod): void => {
    if (credits == null) return
    setPhase('pay')
    void (async () => {
      const res = await createTopupPurchase(credits, method)
      if (res == null) {
        finish('Could not reach the Rayu backend to start the purchase.')
        return
      }
      if (isTopupError(res)) {
        // The server explains why (below the minimum, top-up off, card rail
        // unavailable); show its words rather than a guess.
        finish(res.message)
        return
      }
      setPurchase(res)
      if (res.method === 'stripe') {
        // Card rail: open the hosted Checkout page in the user's browser. The
        // URL is also printed below so a headless / SSH session can still pay
        // (copy-paste into a local browser). The poll loop below watches the
        // payment row and reports paid/expired/canceled like the KHQR rails.
        if (res.checkoutUrl) {
          void openBrowser(res.checkoutUrl)
        }
        return
      }
      // KHQR rail: render the QR inline. res.qr is present for the KHQR rails;
      // guarded anyway so a misshapen response cannot crash the command.
      try {
        if (res.qr) setQrArt(await renderQr(res.qr))
      } catch {
        // Fall back to the raw payload below; a user can still paste it.
        setQrArt(null)
      }
    })()
  }

  if (phase === 'loading' || !quote) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text bold>Buy credits</Text>
        <Text dimColor>Loading current pricing…</Text>
      </Box>
    )
  }

  const header = (
    <Box flexDirection="column">
      <Text bold>Buy credits</Text>
      {/* Rate + minimum, exactly as the admin configured them. */}
      <Text dimColor>{formatTopupRate(quote)}</Text>
      {balance != null && (
        <Text dimColor>
          Current top-up balance: {balance.toLocaleString()} credits
        </Text>
      )}
      {quote.topUpEnabled === false && (
        <Text color="warning">
          Your plan does not spend top-up credits — buying them will not raise
          your limit until you switch plans.
        </Text>
      )}
    </Box>
  )

  if (phase === 'amount') {
    // Amounts are multiples of the SERVER's minimum, so the list re-derives
    // itself whenever the admin changes the rate or the floor.
    const options: OptionWithDescription<string>[] = suggestedTopupAmounts(quote).map(
      (c) => ({
        label: `${c.toLocaleString()} credits`,
        value: String(c),
        description: formatUsd(previewAmountCents(c, quote)),
      }),
    )
    options.push({
      type: 'input',
      label: 'Custom amount (credits)',
      value: 'custom',
      placeholder: String(quote.minCredits),
      description: `${quote.minCredits.toLocaleString()}–${quote.maxCredits.toLocaleString()}`,
      onChange: (raw: string) => {
        setCredits(clampTopupCredits(raw, quote))
        setPhase('method')
      },
    })
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        {header}
        <Select
          options={options}
          inlineDescriptions
          onChange={(v: string) => {
            if (v === 'custom') return
            setCredits(clampTopupCredits(v, quote))
            setPhase('method')
          }}
          onCancel={() => finish('Top-up canceled.')}
        />
        <Text dimColor>(press esc to cancel)</Text>
      </Box>
    )
  }

  if (phase === 'method' && credits != null) {
    const preview = previewAmountCents(credits, quote)
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        {header}
        <Text>
          {credits.toLocaleString()} credits ≈ {formatUsd(preview)} — pay with:
        </Text>
        <Select
          options={RAIL_OPTIONS.map((r) => ({
            label: r.label,
            value: r.value,
            description: r.description,
          }))}
          inlineDescriptions
          onChange={(v: string) => startPurchase(v as TopupMethod)}
          onCancel={() => finish('Top-up canceled.')}
        />
        <Text dimColor>
          Final price is confirmed by the server when the purchase is created.
        </Text>
      </Box>
    )
  }

  if (phase === 'pay') {
    if (!purchase) {
      return (
        <Box flexDirection="column" paddingLeft={1}>
          {header}
          <Text dimColor>Creating your purchase…</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>
          Pay {formatUsd(purchase.amountCents)} for{' '}
          {purchase.credits.toLocaleString()} credits
        </Text>
        {purchase.method === 'stripe' ? (
          <Box flexDirection="column">
            <Text dimColor>
              Complete this card payment in your browser. If it did not open
              automatically, open this URL:
            </Text>
            <Text>{purchase.checkoutUrl ?? '(no checkout URL returned)'}</Text>
          </Box>
        ) : qrArt ? (
          <Text>{qrArt}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>
              Could not draw the QR here — paste this KHQR payload into your
              wallet:
            </Text>
            <Text>{purchase.qr ?? ''}</Text>
          </Box>
        )}
        <Text dimColor>
          {purchase.method === 'stripe'
            ? `Waiting for payment confirmation${'.'.repeat(1 + ((waited / POLL_INTERVAL_MS) % 3))}`
            : `Scan with ${purchase.method === 'aba' ? 'ABA Mobile' : 'any KHQR wallet'} · waiting for payment${'.'.repeat(1 + ((waited / POLL_INTERVAL_MS) % 3))}`}
        </Text>
        {purchase.expiresAt && (
          <Text dimColor>
            Expires {new Date(purchase.expiresAt).toLocaleTimeString()}
          </Text>
        )}
        <Text dimColor>(press esc to cancel this purchase)</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>{error ?? 'Finishing up…'}</Text>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  if (!hasRayuSession()) {
    onDone('Not signed in. Run /login to buy credits.')
    return null
  }
  // `/topup 5000` pre-selects the amount; anything non-numeric just opens the
  // picker. The value is still clamped against the server's live bounds.
  const parsed = Number.parseInt((args ?? '').trim(), 10)
  const initialCredits = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  return (
    <TopupFlow
      onDone={onDone as (result?: string) => void}
      initialCredits={initialCredits}
    />
  )
}
