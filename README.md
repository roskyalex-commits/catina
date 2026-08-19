# Cătină

An AI sales agent for finding B2B leads who are in the market *now* — built
Romania-first, and built to run on free tiers.

Paste your website. It works out who buys from you, finds those companies in
the Romanian trade register, enriches contacts, watches for buying signals, and
drafts the outreach. A competitor to [gojiberry.ai](https://gojiberry.ai),
differing in three ways that matter:

- **Romanian registry data.** ANAF and ONRC are free official APIs with no key
  and no account. That means CAEN activity codes, filed revenue, VAT status and
  insolvency flags for ~4M companies — targeting no international tool can
  express, at zero data cost.
- **Signals you can check.** Every signal links to the filing, job posting or
  article behind it. LinkedIn engagement is deliberately absent: it needs a
  paid API or a terms-violating scraper.
- **Jurisdiction-aware outreach.** "GDPR compliance" is not one rule. Romania
  requires prior opt-in with no B2B exemption (Law 506/2004); the UK allows B2B
  on legitimate interest. Twenty jurisdictions are encoded with their statutes.

## Status

The engine and the interface are both built; nothing is wired to a database yet.
380 tests pass.

With no Supabase project configured the app runs on a **demo dataset** — every
screen is real, and every score in it is computed by the actual scoring engine
rather than written down, so a scoring regression shows up as a wrong number on
screen. A "Demo data" marker sits in the sidebar and disappears on its own once
`NEXT_PUBLIC_SUPABASE_URL` is set.

Nothing has run against live infrastructure. The environment this was built in
had no outbound network access, so anything touching a third party is covered by
tests and fixtures and carries a verification script to run once you have
credentials. See [Verifying against real services](#verifying-against-real-services).

## The product model

An **agent** is the unit of work: a named, scheduled worker with one targeting
profile, its own mailbox, and its own Overview / Leads / Queue / Sources /
Campaign / Activity / Settings. Everything else hangs off it — Contacts is every
lead every agent found, Insights is which launch found what on which day.

Two things the interface deliberately does not have:

- **LinkedIn.** Engagement data needs a paid API or a terms-violating scraper.
  Where a competitor plots "invitations sent", this plots companies sourced and
  signals detected — things it can actually measure.
- **Reply tracking.** Reading a Gmail mailbox needs `gmail.readonly`, which
  Google classifies as *restricted*: an annual CASA Tier 2 assessment, roughly
  $540-1,000/yr. Sending needs only `gmail.send` and `gmail.compose`, which are
  *sensitive* — about ten days of verification, no fee. So outreach works and
  reply rate stays at zero rather than being estimated. Deliverability is
  reported instead, because it is measured.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js on Cloudflare Workers | Vercel's Hobby tier forbids commercial use; Cloudflare's free tier permits it |
| Data | Supabase (Frankfurt) | Postgres + auth + RLS, EU residency for GDPR |
| Jobs | Cloudflare Queues + Cron | Free, and replaces paid Inngest |
| LLM | Claude (`claude-opus-5`) | ICP inference and drafting — the only real cost, a few euro a month |
| Email | Gmail API | `gmail.send` + `gmail.compose` are *sensitive* scopes, so no CASA audit |

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in Supabase + Anthropic keys
npm run db:setup             # schema + row-level security policies
npm run dev
```

Only three variables are required: the Supabase pair, `ANTHROPIC_API_KEY`, and
`ENCRYPTION_KEY` (`openssl rand -base64 32`). Every enrichment provider is
optional — the app degrades to fewer sources rather than failing, and Settings
shows exactly what is wired up.

## Verifying against real services

Run these once you have credentials. Each exists because the corresponding code
could not be exercised at build time.

| Command | Checks |
|---|---|
| `npm run verify:anaf` | ANAF response shapes against the live registry. Prints the raw payload so a mismatch is a one-file fix. **Run before trusting the registry engine.** |
| `npm run verify:rls` | Tenant isolation, by creating two orgs and asserting one cannot see the other. **Non-negotiable before any real user.** |
| `npm run spike:people` | Which enrichment free tiers actually include API access, and what they cover. Decides whether the crawler gets built at all. |

## Commands

```bash
npm run dev            # local dev server
npm test               # 380 tests
npm run typecheck      # tsc --noEmit
npm run lint
npm run cf:deploy      # build + deploy to Cloudflare Workers
npm run db:setup       # drizzle push + RLS policies
```

## Layout

```
src/lib/
  data/         view models + the demo dataset — the seam every page reads
  icp/          website -> structured ICP (the onboarding magic moment)
  crawl/        polite site reader + tech-stack fingerprinting
  sources/      lead sourcing — ANAF/ONRC registry, CAEN, people providers
  enrichment/   email waterfall: patterns, MX, credit ledger
  signals/      buying signals and the scoring engine
  outreach/     Gmail, MIME, jurisdiction rules, send guardrails
  ask/          tools Claude may call to answer questions about your data
  export/       CSV with formula-injection protection
  billing/      plan limits
src/components/
  app-shell/    collapsible rail, navigation
  charts/       hand-rolled SVG area chart (no chart library)
  contacts/     the dense contacts table
scripts/        verification scripts and the coverage spike
drizzle/        schema and RLS policies
```

Pages never touch the database. They read `src/lib/data/*`, which returns typed
view models — fixtures today, queries next. That seam is why the interface will
not have to be rebuilt when persistence lands.

## Known constraints

- **No SMTP verification on Workers.** Outbound port 25 is blocked, so
  per-mailbox checks sit behind the `MailboxVerifier` interface, unimplemented.
  A pattern-derived address therefore never reaches `verified` status on its
  own — which is correct, but means auto-send has less to work with than
  planned.
- **Diff-based signals need two scans.** Tech-stack changes, pricing changes
  and hiring surges produce nothing on a first run, by design.
- **Provider response shapes are unverified.** Coded from vendor documentation,
  not observed calls. Hunter's is the most confident, Prospeo's the least. All
  parse defensively.

## Legal

The jurisdiction rules are summaries written to make the product warn
accurately, not legal advice. Romania is the strict case and this project's
home market: Law 506/2004 requires express prior consent for commercial email
with no B2B exemption, and ANSPDCP fines run RON 5,000–100,000 or up to 2% of
turnover. The app warns and records an acknowledgement; the send decision stays
with the user. Only the do-not-contact list blocks outright.
