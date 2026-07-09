# How tokens are counted & credits are charged — per model

This document explains, for the **Rayu‑hosted (paid) models**, exactly how token
usage is turned into a credit charge, and the per‑model rate for every model
currently offered.

> TL;DR
> - **1 credit = 1,000,000 tokens** (the reference rate).
> - Every model has a rate = **credits per 1,000,000 tokens** (its
>   `creditMultiplier`).
> - You are charged: **`credits = tokens_used × rate ÷ 1,000,000`**, where
>   `tokens_used` is the **actual** input + output tokens the model reported.
> - A **failed or unavailable** request costs **0 credits**.
>
> For the underlying mechanism (reserve/settle, cache‑aware billing, the Redis
> counter), see [`credits-and-limits.md`](./credits-and-limits.md).

---

## 1. The charge formula

Charging happens **in the gateway**, off the model's real usage — not an
estimate. For the active hosted models (served via Ollama Cloud), billing is
**flat**: input tokens and output tokens are charged at the same rate, and there
is no prompt‑cache discount, so:

```
billable_tokens = (input_tokens + output_tokens) × rate
credits_charged = billable_tokens ÷ 1,000,000
              = tokens_used × rate ÷ 1,000,000
```

`rate` is the model's **credits‑per‑1M‑tokens** value (the `creditMultiplier`).
Because `1 credit = 1,000,000 tokens`, the rate reads directly as “credits per
million tokens”.

- `rate = 1.0` → 1,000,000 tokens costs **1 credit**
- `rate = 2.5` → 1,000,000 tokens costs **2.5 credits**
- `rate = 0.75` → 1,000,000 tokens costs **0.75 credits**

Only tokens the provider actually reports are counted; the display in `/usage`
shows the real tokens used, not a rounded‑up number.

---

## 2. Per‑model rates

Rates below are the current defaults. **All of them are admin‑editable** in the
dashboard (Models → per‑model `creditMultiplier`); nothing here is hard‑coded
into the charge.

| Model (id) | Served via | Rate — credits / 1M tokens | Context window | Status |
|---|---|---:|---:|---|
| **DeepSeek V4 Flash** (`deepseek-v4-flash`) | Ollama Cloud | **0.33** | 1M | Active |
| **DeepSeek V4 Pro** (`deepseek-v4-pro`) | Ollama Cloud | **1.0** | 1M | Active |
| **GLM‑5.2** (`glm-5.2`) | Ollama Cloud | **2.5** | 1M | Active |
| **Kimi K2.7** (`kimi-k2.7`) | Ollama Cloud | **2.5** | 256K | Active |
| **MiniMax M3** (`minimax-m3`) | Ollama Cloud | **2.5** | 1M | Active |
| **Llama 4** (`llama-4`) | Ollama Cloud | **1.0** | 1M | Active |
| **GPT‑OSS 120B** (`gpt-oss-120b`) | Ollama Cloud | **0.75** | 128K | Active |
| **Qwen3.5 397B** (`qwen3.5-397b`) | Ollama Cloud | **0.75** | 256K | Active |
| **Qwen3.5 122B** (`qwen3.5-122b`) | Ollama Cloud | **0.75** | 256K | Active |
| **LongCat 2.0** (`longcat-2`) | LongCat | 0.5 | 1M | **Disabled** |

Notes:
- **Only Ollama Cloud is active** right now (`RAYU_DISABLED_PROVIDERS=longcat`).
  LongCat is disabled — its models are hidden from users and any request to them
  is refused (with no charge). The original DeepSeek (official API) provider is
  **not used**; DeepSeek V4 Flash/Pro are served through Ollama Cloud.
- **MiniMax M3** and **Llama 4** rates were not individually specified and use a
  sensible default (2.5 and 1.0) — adjust in the admin dashboard as needed.
- **Context window** is what the CLI reports for the model (used for context
  management). If a model is served by an upstream with a smaller real window,
  set a per‑model context override to avoid overflow.

### Rate tiers at a glance
- **0.33 / 1M** — DeepSeek V4 Flash (cheapest)
- **0.75 / 1M** — GPT‑OSS 120B, Qwen3.5 397B, Qwen3.5 122B
- **1.0 / 1M** — DeepSeek V4 Pro (reference), Llama 4
- **2.5 / 1M** — GLM‑5.2, Kimi K2.7, MiniMax M3

---

## 3. Worked examples

Assume the reference rate (`1 credit = 1,000,000 tokens`).

| Model | Tokens used (in + out) | Charge |
|---|---:|---:|
| DeepSeek V4 Pro (1.0) | 1,000,000 | **1.00 credit** |
| DeepSeek V4 Pro (1.0) | 200,000 | **0.20 credit** |
| DeepSeek V4 Flash (0.33) | 1,000,000 | **0.33 credit** |
| GPT‑OSS 120B (0.75) | 1,000,000 | **0.75 credit** |
| GLM‑5.2 (2.5) | 1,000,000 | **2.50 credits** |
| GLM‑5.2 (2.5) | 40,000 (a small turn) | **0.10 credit** |

A trivial message (e.g. a few thousand tokens) costs a **tiny fraction** of a
credit — it is **not** rounded up to a whole credit.

---

## 4. What a plan buys

A plan grants a **credit allowance per billing period** (`creditsPerPeriod`).
Because `1 credit = 1,000,000 tokens`, the allowance converts to tokens per
model by dividing by the model's rate.

Example — a plan with **50 credits / period**:

| If you only used… | You'd get about… |
|---|---|
| DeepSeek V4 Pro (1.0) | 50,000,000 tokens (50 credits ÷ 1.0) |
| DeepSeek V4 Flash (0.33) | ~151,000,000 tokens (50 ÷ 0.33) |
| GPT‑OSS 120B (0.75) | ~66,000,000 tokens (50 ÷ 0.75) |
| GLM‑5.2 (2.5) | 20,000,000 tokens (50 ÷ 2.5) |

Credits deplete over the period and reset at renewal. When the balance is
exhausted, further hosted requests return a credit‑limit error (or draw from
top‑up credits if the plan enables top‑up). Plan credit amounts and prices are
admin‑configured — see [`credits-and-limits.md`](./credits-and-limits.md).

---

## 5. Edge cases (what you are NOT charged for)

- **Failed / errored request** — if the upstream fails, usage settles to the
  real amount (0 for a failed turn), so a failed request costs **0 credits**.
- **Disabled provider** — a request for a model whose provider is turned off
  returns `503` **before** any reserve, so it charges **0 credits** and does not
  consume a daily turn.
- **Rate‑limited key** — the gateway rotates/fails over across the provider's
  keys automatically; you are only charged for the request that actually
  succeeds, at the model's rate.

---

## 6. Where the numbers live (admin‑editable)

| What | Where |
|---|---|
| Per‑model rate (`creditMultiplier`) + prices | Admin → Models (`hosted_models` table) |
| `1 credit = 1,000,000 tokens` baseline (`baselineCreditsPer1M`) | Admin → Credit Settings (`app_settings`) |
| Plan credit allowance (`creditsPerPeriod`) | Admin → Plans |
| Which providers are active | Gateway env `RAYU_DISABLED_PROVIDERS` (zero‑code) |

The gateway computes every charge from these values at request time — changing a
rate in the dashboard changes the charge with no code change or redeploy of the
CLI. The CLI is display‑only; the gateway is the single source of truth for
billing.
