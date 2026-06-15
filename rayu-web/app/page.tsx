import { Show, SignUpButton } from '@clerk/nextjs'
import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="container">
      <section className="hero">
        <h1>Code in your terminal with Rayu</h1>
        <p>
          Rayu is a multi-provider AI coding agent for your terminal. Bring your
          own API key on the Free plan and run unlimited requests, or wait for
          our hosted plans — coming soon.
        </p>
        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.75rem' }}>
          <Show when="signed-out">
            <SignUpButton>
              <button className="btn">Get started — it&apos;s free</button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Link href="/plans" className="btn">
              View your plan
            </Link>
          </Show>
          <Link href="/plans" className="btn secondary">
            See plans
          </Link>
        </div>
      </section>

      <section className="grid">
        <div className="card">
          <h3>Bring your own key</h3>
          <p style={{ color: 'var(--muted)' }}>
            Connect any provider with <code>/connect</code> and use Rayu free,
            with no request limits.
          </p>
        </div>
        <div className="card">
          <h3>Sign in once</h3>
          <p style={{ color: 'var(--muted)' }}>
            Log in with Google, GitHub, or Facebook to use the Rayu terminal.
          </p>
        </div>
        <div className="card">
          <h3>Chatbot — coming soon</h3>
          <p style={{ color: 'var(--muted)' }}>
            A web chatbot interface is on the way.
          </p>
        </div>
      </section>
    </main>
  )
}
