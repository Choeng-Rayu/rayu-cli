'use client';

import { useEffect, useState, useMemo } from 'react';
import { cn } from '../../lib/utils';
import { motion } from 'framer-motion';
import { Check, X, Star, ArrowRight, Loader, AlertCircle, Key, Server } from 'lucide-react';
import { apiUrl } from '../../lib/config';
import { Plan, sortPlans } from '../../lib/plans';

/* ─────────────────────────────────────────
   Plan metadata (static content, not prices)
───────────────────────────────────────── */
interface PricingFeature {
  text: string;
  included: boolean;
}

const PLAN_DESCRIPTIONS: Record<string, string> = {
  free:       'For individuals and side projects.',
  basic:      'Power up your CLI workflow. BYOK with full features.',
  pro:        'Hosted models. Ideal for keyless developer sessions.',
  pro_plus:   'Best value for active developer swarms.',
  max:        'Designed for heavy power users requiring max throughput.',
  enterprise: 'For organizations at scale.',
};

const PLAN_FEATURES: Record<string, PricingFeature[]> = {
  free: [
    { text: 'Bring Your Own API Keys (BYOK)',          included: true  },
    { text: 'Unlimited daily turn usage limit',               included: true  },
    { text: 'Complete CLI filesystem & shell tools',   included: true  },
    { text: 'Collaborator swarms & subagent models',   included: false },
    { text: 'Native Image & Video generation tools',   included: false },
    { text: 'Telegram bot remote control',             included: false },
    { text: 'P2P Direct Connect',                     included: false},
    { text: 'Absolute Privacy: No Training Data',     included: false },
    
  ],
  basic: [
    { text: 'Bring Your Own API Keys (BYOK)',          included: true },
    { text: 'Unlimited daily turns (no turn cap)',     included: true },
    { text: 'Complete CLI filesystem & shell tools',   included: true },
    { text: 'Collaborator swarms & subagent models',  included: true },
    { text: 'Native Image & Video generation tools',  included: true },
    { text: 'Telegram bot remote control',            included: true },
    { text: 'P2P Direct Connect',                     included: true },
    { text: 'Absolute Privacy: No Training Data',     included: true },


  ],
  pro: [
    { text: 'Rayu Hosted Proxy (No keys needed)',      included: true },
    { text: '50 credits monthly allowance',            included: true },
    { text: 'Unlimited daily turns & features',        included: true },
    { text: 'Collaborator swarms & subagent models',  included: true },
    { text: 'Native Image & Video generation tools',  included: true },
    { text: 'Telegram bot remote control',            included: true },
  ],
  pro_plus: [
    { text: 'Rayu Hosted Proxy (No keys needed)',      included: true },
    { text: '115 credits monthly allowance',           included: true },
    { text: 'Unlimited daily turns & features',        included: true },
    { text: 'Collaborator swarms & subagent models',  included: true },
    { text: 'Native Image & Video generation tools',  included: true },
    { text: 'Telegram bot remote control',            included: true },
  ],
  max: [
    { text: 'Rayu Hosted Proxy (No keys needed)',      included: true },
    { text: '300 credits monthly allowance',           included: true },
    { text: 'Unlimited daily turns & features',        included: true },
    { text: 'Collaborator swarms & subagent models',  included: true },
    { text: 'Native Image & Video generation tools',  included: true },
    { text: 'Telegram bot remote control',            included: true },
  ],
  enterprise: [
    { text: 'Custom credit allowance for teams',      included: true },
    { text: 'Dedicated self-hosted / custom VPC',     included: true },
    { text: 'Single Sign-On (SSO) & SAML',            included: true },
    { text: 'Custom SLA & 24/7 dedicated support',   included: true },
  ],
};

/* ─────────────────────────────────────────
   Price formatting
───────────────────────────────────────── */
function formatPrice(priceCents: number): string {
  if (priceCents === 0) return 'Free';
  const d = priceCents / 100;
  return d % 1 === 0 ? `$${d}` : `$${d.toFixed(2)}`;
}

/* ─────────────────────────────────────────
   PricingCard
───────────────────────────────────────── */
interface CardProps {
  plan: Plan;
  index: number;
  isPopular?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
}

function PricingCard({ plan, index, isPopular = false, isFirst = false, isLast = false }: CardProps) {
  const isFree       = plan.code === 'free';
  const isEnterprise = plan.code === 'enterprise';
  const isAvailable  = plan.availability === 'active';

  // Price label — entirely from admin-set priceCents, no static fallback
  const priceLabel = isEnterprise ? 'Custom' : formatPrice(plan.priceCents);

  // CTA
  let ctaLabel = 'Coming soon';
  let ctaHref: string | null = null;
  if (isAvailable) {
    if (isFree)            { ctaLabel = 'Get started free'; ctaHref = '/dashboard'; }
    else if (isEnterprise) { ctaLabel = 'Contact sales';    ctaHref = 'mailto:sales@rayu.dev?subject=Enterprise%20Plan%20Inquiry'; }
    else                   { ctaLabel = isPopular ? 'Get started' : 'Upgrade'; ctaHref = `/billing?plan=${plan.code}`; }
  } else if (isEnterprise) { ctaLabel = 'Contact sales';    ctaHref = 'mailto:sales@rayu.dev?subject=Enterprise%20Plan%20Inquiry'; }

  const features    = PLAN_FEATURES[plan.code] ?? [];
  const desc        = PLAN_DESCRIPTIONS[plan.code] ?? '';
  const canNavigate = !!ctaHref;

  const radiusClass = isPopular
    ? 'rounded-2xl'
    : cn(
        isFirst && 'rounded-l-2xl rounded-r-none md:border-r-0',
        isLast  && 'rounded-r-2xl rounded-l-none md:border-l-0',
        !isFirst && !isLast && 'rounded-none md:border-r-0',
      );

  return (
    <motion.div
      initial={{ opacity: 0, y: 28 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 + index * 0.08 }}
      className={cn(
        'relative flex flex-col p-6 md:p-8',
        isPopular
          ? 'bg-[#0b0e14] border border-[var(--green)] shadow-[0_0_40px_rgba(0,255,136,0.08)]'
          : 'bg-[#0b0e14] border border-white/5',
        isPopular && 'z-10 md:-my-5 md:py-[3.25rem]',
        radiusClass,
      )}
    >
      {/* Popular badge */}
      {isPopular && (
        <div className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap">
          <span
            className="inline-flex items-center gap-1.5 text-[10px] font-bold tracking-[0.15em] uppercase bg-white text-[#030507] px-4 py-1 rounded-full"
            style={{ fontFamily: 'Orbitron, sans-serif' }}
          >
            <Star className="size-3 fill-amber-400 text-amber-400" />
            Most Popular
          </span>
        </div>
      )}

      {/* Plan name + description */}
      <div className="mb-5">
        <h3 className="text-lg font-bold text-white tracking-wide">{plan.name}</h3>
        <p className="text-sm text-[var(--muted)] mt-1.5 min-h-[2.4rem] leading-relaxed">{desc}</p>
      </div>

      {/* Price — from admin-set priceCents */}
      <div className="mb-6">
        <div className="flex items-baseline gap-1">
          <span
            className="text-5xl font-extrabold tracking-tight text-white"
            style={{ fontFamily: 'Orbitron, sans-serif' }}
          >
            {priceLabel}
          </span>
          {!isFree && !isEnterprise && (
            <span className="text-sm text-[var(--muted)]" style={{ fontFamily: 'DM Mono, monospace' }}>
              /mo
            </span>
          )}
        </div>
      </div>

      {/* CTA */}
      <div className="mb-6">
        {canNavigate ? (
          <a
            href={ctaHref!}
            className={cn(
              'w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all duration-200',
              isPopular
                ? 'bg-[var(--green)] text-[#030507] hover:bg-[var(--green-dim)] hover:shadow-[0_0_18px_var(--green-glow-btn)] hover:-translate-y-px'
                : 'bg-white/[0.03] border border-white/8 text-white hover:bg-white/[0.06] hover:border-white/15 hover:-translate-y-px',
            )}
          >
            {ctaLabel}
            <ArrowRight className="size-4" />
          </a>
        ) : (
          <button
            disabled
            className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold border border-white/[0.03] text-[var(--muted)] cursor-not-allowed"
          >
            {ctaLabel}
          </button>
        )}
      </div>

      {/* Divider */}
      <div className="h-px bg-white/[0.04] mb-4" />

      {/* Features */}
      <ul className="space-y-3 flex-1">
        {features.map((feature, fi) => (
          <motion.li
            key={feature.text}
            className="flex items-start gap-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.25 + index * 0.04 + fi * 0.025 }}
          >
            {feature.included ? (
              <Check className="size-4 mt-0.5 shrink-0 text-[var(--green)]" />
            ) : (
              <X className="size-4 mt-0.5 shrink-0 text-white/15" />
            )}
            <span
              className={cn(
                'text-sm leading-normal',
                feature.included ? 'text-white/75' : 'text-white/20 line-through',
              )}
            >
              {feature.text}
            </span>
          </motion.li>
        ))}
      </ul>
    </motion.div>
  );
}

/* ─────────────────────────────────────────
   Section label
───────────────────────────────────────── */
function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      <div className="h-px flex-1 max-w-[80px] bg-white/5" />
      <span
        className="inline-flex items-center gap-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-[var(--muted)] px-3 py-1 rounded-full border border-white/[0.06]"
        style={{ fontFamily: 'Orbitron, sans-serif' }}
      >
        {icon}
        {children}
      </span>
      <div className="h-px flex-1 max-w-[80px] bg-white/5" />
    </div>
  );
}

/* ─────────────────────────────────────────
   Page
───────────────────────────────────────── */
export default function PlansPage() {
  const [plans, setPlans]      = useState<Plan[]>([]);
  const [loading, setLoading]  = useState(true);
  const [error, setError]      = useState(false);
  const [retryCount, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setPlans([]);

    async function load() {
      try {
        const res = await fetch(apiUrl('/plans'), { cache: 'no-store' });
        if (!res.ok) { if (!cancelled) setError(true); return; }
        const data = (await res.json()) as Plan[];
        if (!data.length) { if (!cancelled) setError(true); return; }
        if (!cancelled) setPlans(sortPlans(data));
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [retryCount]);

  const byokPlans = useMemo(() => ([
    plans.find(p => p.code === 'free'),
    plans.find(p => p.code === 'basic'),
    plans.find(p => p.code === 'enterprise'),
  ].filter(Boolean) as Plan[]), [plans]);

  const hostedPlans = useMemo(() => ([
    plans.find(p => p.code === 'pro'),
    plans.find(p => p.code === 'pro_plus'),
    plans.find(p => p.code === 'max'),
  ].filter(Boolean) as Plan[]), [plans]);

  /* ── Loading state ── */
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-[var(--green)] gap-3">
        <Loader className="size-6 animate-spin" />
        <span className="text-sm font-semibold tracking-widest" style={{ fontFamily: 'Orbitron, sans-serif' }}>
          LOADING PLANS...
        </span>
      </div>
    );
  }

  /* ── Error state ── */
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
        <AlertCircle className="size-10 text-[var(--red)]" />
        <p className="text-white font-semibold text-lg">Could not load pricing</p>
        <p className="text-[var(--muted)] text-sm max-w-xs">
          Our pricing information is unavailable right now. Please try again shortly.
        </p>
        <button
          onClick={() => setRetry(c => c + 1)}
          className="mt-2 px-5 py-2 rounded-xl text-sm font-semibold bg-white/5 border border-white/10 text-white hover:bg-white/10 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <main className="relative z-10 container mx-auto px-4 py-20 max-w-6xl">

      {/* ── Page Header ── */}
      <div className="text-center mb-16">
        <motion.p
          className="text-xs font-semibold tracking-[0.25em] uppercase text-[var(--green)] mb-4"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          style={{ fontFamily: 'Orbitron, sans-serif' }}
        >
          Pricing
        </motion.p>

        <motion.h1
          className="text-4xl md:text-5xl lg:text-6xl font-extrabold tracking-tight text-white mb-4"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.06 }}
        >
          Simple, transparent pricing
        </motion.h1>

        <motion.p
          className="text-[var(--muted)] text-base md:text-lg max-w-lg mx-auto"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.12 }}
        >
          No hidden fees. No surprises. Cancel anytime.
        </motion.p>
      </div>

      {/* ── Row 1: BYOK Tiers ── */}
      <div className="mb-24">
        <SectionLabel icon={<Key className="size-3" />}>
          Bring Your Own Key (BYOK)
        </SectionLabel>

        <div className="grid grid-cols-1 md:grid-cols-3 items-stretch">
          {byokPlans.map((plan, i) => (
            <PricingCard
              key={plan.code}
              plan={plan}
              index={i}
              isPopular={plan.code === 'basic'}
              isFirst={i === 0}
              isLast={i === byokPlans.length - 1}
            />
          ))}
        </div>
      </div>

      {/* ── Row 2: Hosted Credit Tiers ── */}
      <div>
        <SectionLabel icon={<Server className="size-3" />}>
          Rayu Hosted — No API Key Required
        </SectionLabel>

        <div className="grid grid-cols-1 md:grid-cols-3 items-stretch">
          {hostedPlans.map((plan, i) => (
            <PricingCard
              key={plan.code}
              plan={plan}
              index={i}
              isPopular={plan.code === 'pro_plus'}
              isFirst={i === 0}
              isLast={i === hostedPlans.length - 1}
            />
          ))}
        </div>
      </div>

      {/* ── Footer note ── */}
      <motion.p
        className="text-center text-xs text-[var(--muted)] mt-16"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6 }}
      >
        All plans include access to the Rayu CLI. Credits are consumed when using hosted Rayu proxy models.{' '}
        <a href="/docs" className="underline underline-offset-2 hover:text-white transition-colors">
          Learn more
        </a>
      </motion.p>
    </main>
  );
}
