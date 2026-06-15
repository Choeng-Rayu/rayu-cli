import { apiUrl } from '../../lib/config'
import { Plan, sortPlans, toPlanView } from '../../lib/plans'

// Always render at request time; never statically prerender (backend may be
// unavailable at build).
export const dynamic = 'force-dynamic'

// Fallback catalog mirrors the backend seed so the page still renders if the
// API is briefly unavailable.
const FALLBACK: Plan[] = [
  { id: 1, code: 'free', name: 'Free', priceCents: 0, availability: 'active', limits: null },
  { id: 2, code: 'pro', name: 'Pro', priceCents: 1000, availability: 'coming_soon', limits: null },
  { id: 3, code: 'pro_plus', name: 'Pro+', priceCents: 2000, availability: 'coming_soon', limits: null },
  { id: 4, code: 'max', name: 'Max', priceCents: 5000, availability: 'coming_soon', limits: null },
  { id: 5, code: 'enterprise', name: 'Enterprise', priceCents: 0, availability: 'coming_soon', limits: null },
]

async function getPlans(): Promise<Plan[]> {
  try {
    const res = await fetch(apiUrl('/plans'), { cache: 'no-store' })
    if (!res.ok) return FALLBACK
    const data = (await res.json()) as Plan[]
    return data.length ? data : FALLBACK
  } catch {
    return FALLBACK
  }
}

export default async function PlansPage() {
  const plans = sortPlans(await getPlans())
  return (
    <main className="container">
      <h1>Plans</h1>
      <p style={{ color: 'var(--muted)' }}>
        Start free with your own API key. Paid plans are coming soon.
      </p>
      <div className="grid">
        {plans.map((plan) => {
          const v = toPlanView(plan)
          return (
            <div
              key={v.code}
              className={`card${v.highlight ? ' highlight' : ''}`}
              data-testid={`plan-${v.code}`}
            >
              <h3>{v.name}</h3>
              <span className={`badge${v.available ? ' active' : ''}`}>
                {v.available ? 'Available' : 'Coming soon'}
              </span>
              <div className="price">{v.priceLabel}</div>
              <button className="btn" disabled={!v.available && v.code !== 'enterprise'}>
                {v.ctaLabel}
              </button>
            </div>
          )
        })}
      </div>
    </main>
  )
}
