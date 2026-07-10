import Link from 'next/link'
import HeroTerminal from './components/HeroTerminal'
import HeroCTA from './components/HeroCTA'

export default function HomePage() {
  const tickerItems = [
    'Claude 4.5 Sonnet', 'GPT-4o', 'Gemini 2.0 Pro', 'Mistral Large', 'Llama 3.1', 'GitHub API', 'MCP Protocol', 'AWS Bedrock', 'Vertex AI', 'Groq', 'Together AI', 'Ollama', 'LM Studio', 'OpenRouter', 'DeepSeek-V3', 'Anthropic', 'Kimi K2', 'GLM-5.2', 'NVIDIA NIM', 'Cerebras', 'SambaNova', 'Novita', 'Fireworks AI', 'Cohere'
  ]

  const providers = [
    { name: 'Anthropic', tag: 'Claude 4.5' },
    { name: 'OpenAI', tag: 'GPT-4o' },
    { name: 'Google Vertex', tag: 'Gemini 2.0' },
    { name: 'DeepSeek', tag: 'V3 / R1' },
    { name: 'AWS Bedrock', tag: 'Multi-model' },
    { name: 'Mistral', tag: 'Large 2' },
    { name: 'Kimi / Moonshot', tag: 'K2' },
    { name: 'GLM', tag: '5.2' },
    { name: 'Groq', tag: 'Low latency' },
    { name: 'Together AI', tag: 'Hosted OSS' },
    { name: 'OpenRouter', tag: 'Aggregator' },
    { name: 'NVIDIA NIM', tag: 'Self-hosted' },
    { name: 'Cerebras', tag: 'Fast inference' },
    { name: 'SambaNova', tag: 'Fast inference' },
    { name: 'Fireworks AI', tag: 'Hosted OSS' },
    { name: 'Novita', tag: 'Multi-model' },
    { name: 'Cohere', tag: 'Command R+' },
    { name: 'Ollama', tag: 'Local' },
    { name: 'LM Studio', tag: 'Local' },
    { name: 'Llama 3.1', tag: 'Meta OSS' },
  ]

  const testimonials = [
    {
      quote: "It's cool that Cambodia gets to own a tool like this, instead of just reaching for Claude Code every time.",
      name: 'Mengsry Mey',
      role: 'Senior Software Engineer · MRTJC',
      initials: 'MM',
      tag: 'KH National pride',
    },
    {
      quote: "What sets it apart from OpenCode and the rest of the open-source field is per-agent model assignment — Gemini on frontend, Claude Sonnet on backend, Claude Opus running the orchestrator.",
      name: 'Ly Yeak Khai',
      role: 'CEO & Founder · Senior Software Engineer · Dockified',
      initials: 'LK',
      tag: 'Model routing',
    },
    {
      quote: "Genuinely fun to use, and faster than Claude Code or OpenCode at getting to a good result.",
      name: 'Khenchandara Pisey',
      role: 'Senior Web Developer',
      initials: 'KP',
      tag: 'Speed',
    },
    {
      quote: "It ships image and video generation built in, so a frontend dev can stay in one terminal for the whole workflow.",
      name: 'SeavFou Eang',
      role: 'Software Engineering Student · CADT',
      initials: 'SE',
      tag: 'Tooling',
    },
  ]

  return (
    <main className="container">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'Rayu CLI',
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Cross-platform',
            offers: {
              '@type': 'Offer',
              price: '0',
              priceCurrency: 'USD',
            },
            aggregateRating: {
              '@type': 'AggregateRating',
              ratingValue: '5',
              ratingCount: '1',
            },
          }),
        }}
      />
      {/* Hero Section */}
      <section className="grid-2-col" style={{ margin: '2rem 0 6rem 0' }}>
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
            <Link href="/plans" className="btn-hero-primary">Start Building Free →</Link>
            <HeroCTA />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div className="hero-terminal-wrap"><HeroTerminal /></div>
        </div>
      </section>

      {/* Stats Bar */}
      <section className="reveal" style={{ margin: '6rem 0' }}>
        <div className="stagger-container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem' }}>
          <div className="stat-cell stagger-item">
            <div className="stat-num">20+</div>
            <div className="stat-label">Providers Supported</div>
          </div>
          <div className="stat-cell stagger-item">
            <div className="stat-num">600+</div>
            <div className="stat-label">MCP Tools</div>
          </div>
          <div className="stat-cell stagger-item">
            <div className="stat-num">99.9%</div>
            <div className="stat-label">Uptime</div>
          </div>
          <div className="stat-cell stagger-item">
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

      {/* Feature Cards */}
      <section className="reveal" style={{ margin: '6rem 0' }}>
        <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
          <span className="section-eyebrow">FEATURES</span>
          <h2 style={{ marginTop: '0.5rem' }}>Engineered for hyper-growth development</h2>
          <p style={{ color: 'var(--text)', opacity: 0.6, marginTop: '1rem', fontSize: '1.1rem' }}>
            All the tools you need to build, test, and ship from a single command prompt.
          </p>
        </div>
        <div className="stagger-container grid-3-col">
          <div className="card stagger-item">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>01 / CONNECT</div>
            <h3 className="card-title">Multi-Provider</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>Connect any LLM with the simple <code>/connect</code> command. Switch providers on the fly.</p>
          </div>
          <div className="card stagger-item">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>02 / PROTOCOL</div>
            <h3 className="card-title">MCP Servers</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>Unlock 600+ tools through Model Context Protocol — databases, browsers, file systems, and more.</p>
          </div>
          <div className="card stagger-item">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>03 / EXECUTE</div>
            <h3 className="card-title">Autonomous Agents</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>Deploy agents that read, think, plan, write, test, and correct their own errors automatically.</p>
          </div>
          <div className="card stagger-item">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>04 / CLI-NATIVE</div>
            <h3 className="card-title">Terminal Native</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>Built for keyboard warriors. Full shell access, git integration, local commands.</p>
          </div>
          <div className="card stagger-item">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>05 / PERSISTENCE</div>
            <h3 className="card-title">Persistent Memory</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>Retains context across sessions — project specifics, past bugs, and conventions remembered automatically.</p>
          </div>
          <div className="card stagger-item">
            <div style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'DM Mono, monospace' }}>06 / LIBRE</div>
            <h3 className="card-title">Open Source</h3>
            <p style={{ color: 'var(--text)', opacity: 0.7, fontSize: '0.95rem', lineHeight: '1.6' }}>Self-hostable, customizable, BYOK forever free. Run entirely locally with open-weights models.</p>
          </div>
        </div>
      </section>

      {/* Why Rayu Outperforms — Standout comparison */}
      <section className="reveal" style={{ margin: '6rem 0' }}>
        <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
          <span className="section-eyebrow">BENCHMARK</span>
          <h2 style={{ marginTop: '0.5rem' }}>Why Rayu outperforms the rest</h2>
          <p style={{ color: 'var(--text)', opacity: 0.6, marginTop: '1rem', fontSize: '1.1rem' }}>
            Built from the ground up to outperform every other CLI agent on the market. Faster, private, and provider-agnostic.
          </p>
        </div>
        <div className="table-scroll">
          <table className="compare-table reveal">
            <thead>
              <tr>
                <th>Feature</th>
                <th className="rayu-col">Rayu</th>
                <th>OpenCode</th>
                <th>KiloCode</th>
                <th>Claude Code</th>
                <th>Codex</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="row-label">Response Speed</td>
                <td className="rayu-col"><span className="cmp-icon yes">◈</span><span className="cmp-text positive">&lt;500ms</span></td>
                <td><span className="cmp-text dim">~3–5s</span></td>
                <td><span className="cmp-text dim">~5–10s</span></td>
                <td><span className="cmp-text dim">~5–8s</span></td>
                <td><span className="cmp-text dim">~3–6s</span></td>
              </tr>
              <tr>
                <td className="row-label">P2P Collaboration</td>
                <td className="rayu-col"><span className="cmp-icon yes">◈</span><span className="cmp-text positive">Native</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
              </tr>
              <tr>
                <td className="row-label">Privacy / No Training Data</td>
                <td className="rayu-col"><span className="cmp-icon yes">◈</span><span className="cmp-text positive">Zero retention</span></td>
                <td><span className="cmp-icon warn">◐</span><span className="cmp-text warning">Cloud-dependent</span></td>
                <td><span className="cmp-icon warn">◐</span><span className="cmp-text warning">Cloud-dependent</span></td>
                <td><span className="cmp-icon no">✕</span><span className="cmp-text negative">Trains on your code</span></td>
                <td><span className="cmp-icon no">✕</span><span className="cmp-text negative">Trains on your code</span></td>
              </tr>
              <tr>
                <td className="row-label">Multi-Provider BYOK</td>
                <td className="rayu-col"><span className="cmp-icon yes">◈</span><span className="cmp-text positive">20+ providers</span></td>
                <td><span className="cmp-icon warn">◐</span><span className="cmp-text warning">Limited</span></td>
                <td><span className="cmp-icon no">✕</span><span className="cmp-text negative">Single</span></td>
                <td><span className="cmp-icon no">✕</span><span className="cmp-text negative">Anthropic only</span></td>
                <td><span className="cmp-icon no">✕</span><span className="cmp-text negative">OpenAI only</span></td>
              </tr>
              <tr>
                <td className="row-label">Agent Swarms</td>
                <td className="rayu-col"><span className="cmp-icon yes">◈</span><span className="cmp-text positive">Built-in &amp; parallel</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
              </tr>
              <tr>
                <td className="row-label">Offline / Local Models</td>
                <td className="rayu-col"><span className="cmp-icon yes">◈</span><span className="cmp-text positive">Private local support</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
                <td><span className="cmp-icon neutral">—</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Providers Grid — expanded support */}
      <section className="reveal" style={{ margin: '6rem 0' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <span className="section-eyebrow">PROVIDERS</span>
          <h2 style={{ marginTop: '0.5rem' }}>One CLI. Every provider you use.</h2>
          <p style={{ color: 'var(--text)', opacity: 0.6, marginTop: '1rem', fontSize: '1.1rem' }}>
            Bring your own key or use the Rayu-hosted gateway. Switch models mid-session with <code>/model</code> — no rewrites, no lock-in.
          </p>
        </div>
        <div className="stagger-container provider-grid">
          {providers.map((p) => (
            <div key={p.name} className="provider-chip stagger-item">
              <span className="provider-dot" />
              <span className="provider-name">{p.name}</span>
              <span className="provider-tag">{p.tag}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Client Feedback — Testimonials */}
      <section className="reveal" style={{ margin: '6rem 0' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <span className="section-eyebrow">TESTIMONIALS</span>
          <h2 style={{ marginTop: '0.5rem' }}>What our clients say about us</h2>
          <p style={{ color: 'var(--text)', opacity: 0.6, marginTop: '1rem', fontSize: '1.1rem' }}>
            Real feedback from engineers who ran Rayu CLI on real work.
          </p>
        </div>
        <div className="stagger-container testimonial-grid">
          {testimonials.map((t) => (
            <div key={t.name} className="testimonial-card stagger-item">
              <div className="testimonial-ribbon" />
              <div className="testimonial-card-top">
                <div className="testimonial-avatar">{t.initials}</div>
                <div className="testimonial-who">
                  <div className="testimonial-name">{t.name}</div>
                  <div className="testimonial-role">{t.role}</div>
                </div>
              </div>
              <div className="testimonial-quote-wrap">
                <span className="testimonial-quote-mark">&ldquo;</span>
                <p className="testimonial-text">{t.quote}</p>
              </div>
              <div className="testimonial-rating-row">
                <div className="testimonial-stars">
                  <span className="star">★</span><span className="star">★</span><span className="star">★</span><span className="star">★</span><span className="star">★</span>
                </div>
                <div className="testimonial-tag">
                  <span>◈</span> {t.tag}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <section style={{ marginTop: '8rem', marginBottom: '4rem', background: 'linear-gradient(180deg, var(--bg2) 0%, var(--bg3) 100%)', border: '1px solid var(--border-bright)', borderRadius: '16px', padding: '5rem 3rem', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: '300px', height: '1px', background: 'linear-gradient(90deg, transparent, var(--green), transparent)' }} />
        <h2 style={{ fontSize: '2.5rem', marginBottom: '1.5rem', lineHeight: '1.2' }}>Your first agent is one command away.</h2>
        <p style={{ color: 'var(--text)', opacity: 0.8, fontSize: '1.1rem', maxWidth: '600px', margin: '0 auto 2.5rem auto', lineHeight: '1.6' }}>
          Get access to Rayu Terminal now. Bring your own keys and scale your development speed to infinity.
        </p>
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link href="/plans" className="btn-hero-primary">Start Building Free →</Link>
          <Link href="/plans" className="btn-hero-ghost">See plans</Link>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: '1px solid var(--border)', paddingTop: '2.5rem', marginTop: '6rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1.5rem', color: 'var(--text)', opacity: 0.5, fontSize: '0.9rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'Orbitron, sans-serif', fontWeight: 900, letterSpacing: '2px', color: '#ffffff' }}>
          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--green)' }} />
          RAYU
        </div>
        <div style={{ display: 'flex', gap: '2rem' }}>
          <a href="#">Privacy</a>
          <a href="#">Terms</a>
          <a href="https://github.com/Choeng-Rayu/rayu-cli" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
        <div>&copy; {new Date().getFullYear()} Rayu Inc. All rights reserved.</div>
      </footer>
    </main>
  )
}
