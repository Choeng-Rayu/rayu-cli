"use client";

import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Check, X, Star, ArrowRight } from "lucide-react";

/* ─────────────────────────────
   Types
───────────────────────────── */
export interface PricingFeature {
  text: string;
  included: boolean;
}

export interface PricingTier {
  name: string;
  description: string;
  /** Monthly price in cents (admin-set). 0 = free, -1 = custom/contact sales. */
  priceCents: number;
  features: PricingFeature[];
  cta: string;
  ctaHref?: string;
  popular?: boolean;
  badge?: string;
  disabled?: boolean;
}

export interface PricingSectionProps {
  title?: string;
  subtitle?: string;
  tiers: PricingTier[];
  className?: string;
}

/* ─────────────────────────────
   Price formatting
───────────────────────────── */
function formatPrice(priceCents: number): string {
  if (priceCents === 0)  return "Free";
  if (priceCents === -1) return "Custom";
  const d = priceCents / 100;
  return d % 1 === 0 ? `$${d}` : `$${d.toFixed(2)}`;
}

/* ─────────────────────────────
   Main Component
───────────────────────────── */
export function Component({
  title = "Simple, transparent pricing",
  subtitle = "No hidden fees. Cancel anytime.",
  tiers,
  className,
}: PricingSectionProps) {
  return (
    <section className={cn("w-full max-w-5xl mx-auto px-4 py-20", className)}>
      {/* ── Header ── */}
      <div className="text-center mb-10">
        <motion.h2
          className="text-3xl md:text-4xl font-bold tracking-tight text-rayu-text mb-3"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {title}
        </motion.h2>

        <motion.p
          className="text-rayu-muted text-base md:text-lg"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          {subtitle}
        </motion.p>
      </div>

      {/* ── Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 items-stretch">
        {tiers.map((tier, i) => {
          const isFirst  = i === 0;
          const isLast   = i === tiers.length - 1;
          const isFree   = tier.priceCents === 0;
          const isCustom = tier.priceCents === -1;

          return (
            <motion.div
              key={tier.name}
              className={cn(
                "relative flex flex-col p-6 md:p-8",
                "bg-rayu-bg2 border border-rayu-border",
                tier.popular &&
                  "border-rayu-green shadow-[0_0_40px_rgba(0,255,136,0.08)] z-10 md:-my-5 md:py-[3.25rem]",
                tier.popular
                  ? "rounded-2xl"
                  : cn(
                      isFirst && "rounded-l-2xl rounded-r-none md:border-r-0",
                      isLast  && "rounded-r-2xl rounded-l-none md:border-l-0",
                      !isFirst && !isLast && "rounded-none md:border-r-0"
                    )
              )}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.15 + i * 0.1 }}
            >
              {/* Popular badge */}
              {tier.badge && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap">
                  <span
                    className="inline-flex items-center gap-1.5 text-[10px] font-bold tracking-[0.15em] uppercase bg-white text-rayu-bg px-4 py-1 rounded-full"
                    style={{ fontFamily: "Orbitron, sans-serif" }}
                  >
                    <Star className="size-3 fill-amber-400 text-amber-400" />
                    {tier.badge}
                  </span>
                </div>
              )}

              {/* Tier info */}
              <div className="mb-5">
                <h3 className="text-lg font-bold text-rayu-text tracking-wide">
                  {tier.name}
                </h3>
                <p className="text-sm text-rayu-muted mt-1.5 min-h-[2.4rem] leading-relaxed">
                  {tier.description}
                </p>
              </div>

              {/* Price — from admin-set priceCents */}
              <div className="mb-6">
                <div className="flex items-baseline gap-1">
                  <span
                    className="text-5xl font-extrabold tracking-tight text-rayu-text"
                    style={{ fontFamily: "Orbitron, sans-serif" }}
                  >
                    {formatPrice(tier.priceCents)}
                  </span>
                  {!isFree && !isCustom && (
                    <span
                      className="text-sm text-rayu-muted"
                      style={{ fontFamily: "DM Mono, monospace" }}
                    >
                      /mo
                    </span>
                  )}
                </div>
              </div>

              {/* CTA */}
              <div className="mb-6">
                {tier.disabled ? (
                  <button
                    disabled
                    className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold border border-white/5 text-rayu-muted cursor-not-allowed"
                  >
                    {tier.cta}
                  </button>
                ) : tier.ctaHref ? (
                  <a
                    href={tier.ctaHref}
                    className={cn(
                      "w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all duration-200",
                      tier.popular
                        ? "bg-rayu-green text-rayu-bg hover:bg-rayu-green-dim hover:shadow-[0_0_18px_rgba(0,255,136,0.35)] hover:-translate-y-px"
                        : "bg-white/[0.03] border border-white/8 text-rayu-text hover:bg-white/[0.06] hover:border-white/15 hover:-translate-y-px"
                    )}
                  >
                    {tier.cta}
                    <ArrowRight className="size-4" />
                  </a>
                ) : (
                  <button
                    className={cn(
                      "w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all duration-200",
                      tier.popular
                        ? "bg-rayu-green text-rayu-bg hover:bg-rayu-green-dim hover:shadow-[0_0_18px_rgba(0,255,136,0.35)] hover:-translate-y-px"
                        : "bg-white/[0.03] border border-white/8 text-rayu-text hover:bg-white/[0.06] hover:border-white/15 hover:-translate-y-px"
                    )}
                  >
                    {tier.cta}
                    <ArrowRight className="size-4" />
                  </button>
                )}
              </div>

              {/* Divider */}
              <div className="h-px bg-rayu-border mb-4" />

              {/* Features */}
              <ul className="space-y-3 flex-1">
                {tier.features.map((feature, fi) => (
                  <motion.li
                    key={feature.text}
                    className="flex items-start gap-2.5"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3 + i * 0.05 + fi * 0.02 }}
                  >
                    {feature.included ? (
                      <Check className="size-4 mt-0.5 shrink-0 text-rayu-green" />
                    ) : (
                      <X className="size-4 mt-0.5 shrink-0 text-white/15" />
                    )}
                    <span
                      className={cn(
                        "text-sm leading-normal",
                        feature.included
                          ? "text-white/75"
                          : "text-white/20 line-through"
                      )}
                    >
                      {feature.text}
                    </span>
                  </motion.li>
                ))}
              </ul>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
