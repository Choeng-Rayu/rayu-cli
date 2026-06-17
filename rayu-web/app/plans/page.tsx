import { apiUrl } from '../../lib/config'
import { Plan, sortPlans, toPlanView } from '../../lib/plans'

// Always render at request time; never statically prerender (backend may be
// unavailable at build).
export const dynamic = 'force-dynamic'

// Fallback catalog mirrors the backend seed so the page still renders if the
// API is briefly unavailable.
const FALLBACK: Plan[] = [
  { id: 1, code: 'free', name: 'Free', priceCents: 0, availability: 'active', limits: null },
  { id: 2, code: 'basic', name: 'Basic', priceCents: 300, availability: 'active', limits: null },
  { id: 3, code: 'pro', name: 'Pro', priceCents: 1000, availability: 'coming_soon', limits: null },
  { id: 4, code: 'pro_plus', name: 'Pro+', priceCents: 2000, availability: 'coming_soon', limits: null },
  { id: 5, code: 'max', name: 'Max', priceCents: 5000, availability: 'coming_soon', limits: null },
  { id: 6, code: 'enterprise', name: 'Enterprise', priceCents: 0, availability: 'coming_soon', limits: null },
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
      <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
        <span className="section-eyebrow">PRICING</span>
        <h1 style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>Plans &amp; Pricing</h1>
        <p style={{ color: 'var(--text)', opacity: 0.6, fontSize: '1.1rem', maxWidth: '600px', margin: '0 auto' }}>
          Start free with your own API key. Paid hosting and collaborative team options are coming soon.
        </p>
      </div>

      <div className="grid">
        {plans.map((plan) => {
          const v = toPlanView(plan)
          return (
            <div
              key={v.code}
              className={`card${v.highlight ? ' highlight' : ''}`}
              data-testid={`plan-${v.code}`}
              style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '340px' }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                  <h3 className="card-title">{v.name}</h3>
                  <span className={`badge${v.available ? ' active' : ''}`}>
                    {v.available ? 'Available' : 'Coming soon'}
                  </span>
                </div>
                <div className="price" style={{ margin: '1.5rem 0' }}>
                  {v.priceLabel}
                </div>
                <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.9rem', lineHeight: '1.5', marginBottom: '1.5rem' }}>
                  {v.code === 'free' && 'Perfect for individual developers. BYO API keys and run unlimited agents with zero request limits.'}
                  {v.code === 'pro' && 'More speed, higher rate limits, and hosted orchestration. Ideal for professional keyboard warriors.'}
                  {v.code === 'pro_plus' && 'Includes persistent cloud context, advanced team features, and shared memory caches.'}
                  {v.code === 'max' && 'Designed for heavy power users requiring max throughput, dedicated context windows, and SLA guarantees.'}
                  {v.code === 'enterprise' && 'Tailored security, single-sign-on (SSO), self-hosted options, and custom VPC connections.'}
                </p>
              </div>
              {v.available && !['free', 'enterprise'].includes(v.code) ? (
                <a
                  href={`/billing?plan=${v.code}`}
                  className="btn-primary"
                  style={{ width: '100%', marginTop: 'auto', display: 'block', textAlign: 'center', textDecoration: 'none' }}
                >
                  {v.ctaLabel}
                </a>
              ) : (
                <button
                  className={v.available || v.code === 'enterprise' ? "btn-primary" : "btn-ghost"}
                  disabled={!v.available && v.code !== 'enterprise'}
                  style={{ width: '100%', marginTop: 'auto' }}
                >
                  {v.ctaLabel}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </main>
  )
}
