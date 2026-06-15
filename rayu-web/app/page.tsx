import { Show, SignUpButton } from '@clerk/nextjs'
import Link from 'next/link'
import HeroTerminal from './components/HeroTerminal'

export default function HomePage() {
  const tickerItems = [
    'Claude 3.5 Sonnet', 'GPT-4o', 'Gemini 1.5 Pro', 'Mistral Large', 'Llama 3.1', 'GitHub API', 'MCP Protocol', 'AWS Bedrock', 'Vertex AI', 'Groq', 'Together AI', 'Ollama', 'OpenRouter', 'DeepSeek-V2', 'Anthropic'
  ]

  return (
    <main className="container">
      {/* Hero Section */}
      <section className="grid-2-col" style={{ margin: '2rem 0 6rem 0' }}>
        {/* Left copy */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          <div className="badge active" style={{ marginBottom: '1.5rem', gap: '6px' }}>
            <span className="pulse" style={{ color: 'var(--green)' }}>◈</span> Multi-provider AI coding agent
          </div>
          <h1 style={{ marginBottom: '1.5rem' }}>
            Code with agents that <span style={{ color: 'var(--green)', textShadow: '0 0 20px var(--green-glow)' }}>think,</span> act, and ship.
          </h1>
          <p style={{ color: 'var(--text)', opacity: 0.8, fontSize: '1.15rem', lineHeight: '1.7', marginBottom: '2.5rem', maxWidth: '580px' }}>
            Rayu is a multi-provider terminal AI coding agent. Bring your own API key, connect any model, and ship faster with autonomous agents that write, test, and deploy your code.
          </p>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', width: '100%' }}>
            <Show when="signed-out">
              <SignUpButton>
                <button className="btn-hero-primary">Start Building Free →</button>
              </SignUpButton>
            </Show>
            <Show when="signed-in">
              <Link href="/plans" className="btn-hero-primary">
                Start Building Free →
              </Link>
            </Show>
            <button className="btn-terminal">$ npm install -g rayu</button>
          </div>
          {/* Social Proof */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '3rem' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(135deg, #00FF88, #0055ff)', border: '2px solid #030507' }} />
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(135deg, #FF3366, #ff00ff)', border: '2px solid #030507', marginLeft: '-10px' }} />
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(135deg, #00FF88, #ffaa00)', border: '2px solid #030507', marginLeft: '-10px' }} />
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(135deg, #0055ff, #FF3366)', border: '2px solid #030507', marginLeft: '-10px' }} />
            </div>
            <span style={{ fontSize: '0.9rem', color: 'var(--text)', opacity: 0.65 }}>
              Used by <strong style={{ color: '#ffffff', fontWeight: 600 }}>2,400+ engineers</strong> shipping agents today
            </span>
          </div>
        </div>

        {/* Right Terminal Widget */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <HeroTerminal />
        </div>
      </section>

      {/* Stats Bar */}
      <section style={{ margin: '6rem 0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem' }}>
          <div className="stat-cell">
            <div className="stat-num">15+</div>
            <div className="stat-label">Models Supported</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">600+</div>
            <div className="stat-label">MCP Tools</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">99.9%</div>
            <div className="stat-label">Uptime</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">0</div>
            <div className="stat-label">Vendor Lock-in</div>
          </div>
        </div>
      </section>

      {/* Integration Ticker */}
      <div className="ticker-container">
        <div className="ticker-track">
          {[...tickerItems, ...tickerItems].map((item, index) => (
            <div key={index} className="ticker-item">
              <span style={{ color: 'var(--green)', opacity: 0.8 }}>◈</span> {item}
            </div>
          ))}
        </div>
      </div>

      {/* Feature Cards Section */}
      <section style={{ margin: '6rem 0' }}>
        <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
          <span className="section-eyebrow">FEATURES</span>
          <h2 style={{ marginTop: '0.5rem' }}>Engineered for hyper-growth development</h2>
          <p style={{ color: 'var(--text)', opacity: 0.6, marginTop: '1rem', fontSize: '1.1rem' }}>
            All the tools you need to build, test, and ship from a single command prompt.
          </p>
        </div>

        <div className="grid-3-col">
          <div className="card">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>01 / CONNECT</div>
            <h3 className="card-title">Multi-Provider</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>
              Connect any LLM with the simple <code>/connect</code> command. Switch providers on the fly depending on your speed, cost, or accuracy requirements.
            </p>
          </div>
          <div className="card">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>02 / PROTOCOL</div>
            <h3 className="card-title">MCP Servers</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>
              Unlock a massive library of 600+ tools through Model Context Protocol. Easily connect to databases, browser APIs, file systems, and more.
            </p>
          </div>
          <div className="card">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>03 / EXECUTE</div>
            <h3 className="card-title">Autonomous Agents</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>
              Deploy agents that run continuous, multi-step execution loops. Rayu will read, think, plan, write, test, and correct its own errors automatically.
            </p>
          </div>
          <div className="card">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>04 / CLI-NATIVE</div>
            <h3 className="card-title">Terminal Native</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>
              Built exclusively for keyboard warriors. Run terminal-native workflows right from your shell with full access to git and local commands.
            </p>
          </div>
          <div className="card">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>05 / PERSISTENCE</div>
            <h3 className="card-title">Persistent Memory</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>
              Retain deep context across terminal sessions. Rayu remembers project specifics, past bugs, conventions, and previous edits automatically.
            </p>
          </div>
          <div className="card">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>06 / LIBRE</div>
            <h3 className="card-title">Open Source</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>
              Self-hostable, customizable, and BYOK forever free. Inspect the code, tweak the prompts, and run entirely locally with open-weights models.
            </p>
          </div>
        </div>
      </section>

      {/* Footer CTA Box */}
      <section style={{
        marginTop: '8rem',
        marginBottom: '4rem',
        background: 'linear-gradient(180deg, var(--bg2) 0%, var(--bg3) 100%)',
        border: '1px solid var(--border-bright)',
        borderRadius: '16px',
        padding: '5rem 3rem',
        textAlign: 'center',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 10px 40px rgba(0,255,136,0.03)'
      }}>
        <div style={{
          position: 'absolute',
          top: '0',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '300px',
          height: '1px',
          background: 'linear-gradient(90deg, transparent, var(--green), transparent)',
        }} />

        <h2 style={{ fontSize: '2.5rem', marginBottom: '1.5rem', lineHeight: '1.2' }}>
          Your first agent is one command away.
        </h2>
        <p style={{ color: 'var(--text)', opacity: 0.8, fontSize: '1.1rem', maxWidth: '600px', margin: '0 auto 2.5rem auto', lineHeight: '1.6' }}>
          Get access to Rayu Terminal now. Bring your own keys and scale your development speed to infinity.
        </p>

        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <Show when="signed-out">
            <SignUpButton>
              <button className="btn-hero-primary">Start Building Free →</button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Link href="/plans" className="btn-hero-primary">
              Start Building Free →
            </Link>
          </Show>
          <Link href="/plans" className="btn-hero-ghost">See plans</Link>
        </div>
      </section>

      {/* Simple Footer */}
      <footer style={{
        borderTop: '1px solid var(--border)',
        paddingTop: '2.5rem',
        marginTop: '6rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '1.5rem',
        color: 'var(--text)',
        opacity: 0.5,
        fontSize: '0.9rem'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'Orbitron, sans-serif', fontWeight: 900, letterSpacing: '2px', color: '#ffffff' }}>
          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--green)' }} />
          RAYU
        </div>
        <div style={{ display: 'flex', gap: '2rem' }}>
          <a href="#">Privacy</a>
          <a href="#">Terms</a>
          <a href="https://github.com" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
        <div>
          &copy; {new Date().getFullYear()} Rayu Inc. All rights reserved.
        </div>
      </footer>
    </main>
  )
}
