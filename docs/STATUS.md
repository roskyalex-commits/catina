# Where this project is

Written for whoever (human or agent) picks this up next, so nothing has to be
re-explained or re-derived. Update it when the answers change.

- **Branch:** `main`, pushed to `github.com/roskyalex-commits/catina`.
- **Last commit:** `f2a4b61` — the email waterfall is connected, leads carry
  addresses, and domain-from-search is built and waiting on a key.
- **Green:** 671 tests, clean `typecheck` and `lint`.
- **Steps 1–4 are done and visible.** Sourcing produces scored leads from the
  real registry, and `/app` renders them — 758 leads for one agent over the
  Cluj slice. The database holds **11,597 Cluj companies**, **11,438**
  ANAF-enriched, and **11,217 named decision-makers** (82% of companies have
  someone to write to).
- **Step 5a is done and proved on live data.** The waterfall is connected, 37
  role addresses are harvested, and the first enriched leads moved **45 → 54**.
- **Step 5b is now the whole product.** Everything is bounded by one number:
  only **1% of companies have a domain**, and without one there is no free way
  to reach anybody. Read the next section.

## The 45-point ceiling, and what lifting it costs

Every lead used to score exactly 45, and it was not a coincidence — it was a
ceiling. `scoreLead` weights ICP fit 0.45, signals 0.35, contactability 0.20.
With no email, contactability contributes **exactly zero**, so a perfect-fit
lead with no signals lands at 0.45 × 100 = 45.

That is now fixed, and the fix works. What it revealed is where the real
constraint lives.

**Measured on the live database, not estimated:**

| Step | Result |
|---|---|
| Companies with a domain | **140 of 11,597** — 1.2% |
| Of those, publishing a role address | **37 of 140** — **26.4%** |
| Leads with a domain, after sourcing 758 | **5** |
| Of those, resolved to an address | **3 of 5** — 60% |
| Score movement on a hit | **45 → 54**, every time |

So the pipeline converts at roughly **26%** once it has a domain, and the free
path is genuinely free — no key, no quota, one page fetch per company. The
funnel does not leak at enrichment. It leaks at the very top: 99% of the
register has no website on file, so there is nothing to crawl.

**That makes domain discovery the highest-value thing left** — not as a feature
in its own right, but because it is the only input the email pipeline is short
of. Each domain found is worth ~0.26 of an email.

The 54 is a role address (`office@`, `contact@`) at 0.55 confidence with the
0.7 role-address penalty. A verified personal address would reach ~65, which
needs either a vendor (step 5c) or mailbox verification (step 5d).

> If you are reading this in an unzipped export rather than a clone, there is no
> git history in the folder and `npm install` has to run before anything else.

## What this is

Cătină: an AI sales agent that finds B2B leads who are in the market *now*.
Paste a website, it infers who buys from you, finds those companies in the
Romanian trade register, enriches contacts, watches for buying signals, drafts
outreach. Romania-first, built to run on free tiers. See `README.md` for the
pitch and the stack table.

## The one thing to understand first

**Everything third-party was written from documentation, never from an observed
response.** The environment this was built in had no outbound network beyond
npm, GitHub, Google Fonts and the Anthropic API. ANAF, ONRC, Supabase, Hunter
and Google were all unreachable — the gateway denied CONNECT at the proxy.

So the code is careful in a specific way: it parses defensively, it never
assumes a field exists, and anything untestable ships with a script that prints
the raw payload. Treat the verified/unverified ledger below as the real status,
not the test count.

## Setup from zero

```bash
npm install
npm run dev            # works immediately — no configuration needed
```

With no `.env.local` the app runs on a **demo dataset**: every screen renders,
and every score in it is computed by the real scoring engine rather than
written down. A "Demo data" marker sits in the sidebar and disappears on its
own once `NEXT_PUBLIC_SUPABASE_URL` is set. This is why `src/proxy.ts` returns
early when Supabase env is absent — without that, constructing the client threw
and every route 500'd.

To go beyond demo mode:

1. Supabase project at [database.new](https://database.new), **region Frankfurt
   (eu-central-1)**. Romanian personal data should stay in the EU; this is a
   design constraint, not a preference.
2. Fill `.env.local` from `.env.example`. Only five values matter to start:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (the **session pooler** URI,
   port 5432 — not the direct connection), `ANTHROPIC_API_KEY`. Plus
   `ENCRYPTION_KEY` from `openssl rand -base64 32`.
3. Supabase dashboard → Authentication → Sign In / Providers → Email → turn
   **Confirm email off**. The built-in mailer is capped at a few messages an
   hour and will block testing. The confirmation flow is built and works; it is
   just unusable for local development.
4. Supabase dashboard → Authentication → URL Configuration → Site URL
   `http://localhost:3000`.

```bash
npm run db:setup       # drizzle push, then apply RLS policies
npm run verify:rls     # MUST fully pass before any real user exists
npm run db:types       # replaces the placeholder Database type (see below)
```

The other `verify:*` scripts each drive one route against the running app with
a throwaway tenant and delete it afterwards. Run them after touching the thing
they cover: `verify:agents`, `verify:sourcing`, `verify:emails`.

`verify:rls` creates two workspaces and asserts one cannot read the other. It
is not optional — an un-policied tenant table is a cross-org data leak.

It is no longer the only check, though. `src/lib/db/policies.test.ts` applies
the same schema and the same `policies.sql` to an in-process Postgres (PGlite,
WASM — no daemon, no network, no Supabase) and asserts the isolation directly.
That runs in `npm test`. The two are complementary: the test proves **the SQL is
correct**, `verify:rls` proves **this Supabase project is configured correctly**.
Neither substitutes for the other, and the second still gates a real user.

## Verified vs unverified

| Area | State |
|---|---|
| All 18 `/app` routes render | **Verified** — 200 in dev, screenshotted at 1440px |
| No page scrolls horizontally | **Verified** — all 19 routes measured at 1440 / 768 / 375px, zero overflow |
| Scoring, compliance, MIME, CSV, patterns, seniority | **Verified** — 391 unit tests |
| Chart geometry | **Verified** — monotone-cubic overshoot is explicitly tested |
| Demo mode with no env | **Verified** |
| Agent create/list mapping + validation | **Verified** — 27 unit tests on the pure layer |
| `POST`/`GET /api/v1/agents` against a real table | **Verified** — `npm run verify:agents`, 20 checks against the live database |
| Schema DDL + `policies.sql` apply | **Verified** — against real Postgres (PGlite/WASM) in `src/lib/db/policies.test.ts` |
| Tenant isolation (the actual boundary) | **Verified** — two orgs, cross-org read/insert/update/delete all denied, secrets deny-all, offline, ~1.5s |
| `db:setup` against Supabase | **Verified** — applied to a live Frankfurt project |
| `verify:rls` against Supabase | **Verified** — full pass, isolation holds |
| Auth signup → workspace → `/app` | **Verified** — org + owner membership created, demo marker gone |
| ANAF response field names | **Verified** — `npm run verify:anaf` passes fully against the live API |
| ANAF enrichment end to end | **Verified** — 11,438 companies enriched: VAT, e-Factura, inactive flag, real CAEN |
| Decision-makers from ONRC | **Verified** — 11,217 people, 82% company coverage, no vendor and no cost |
| Sourcing run → scored leads | **Verified** — `npm run verify:sourcing`, 19 checks against the live registry |
| `/app` reads real data | **Verified** — dashboard, contacts, agent detail and insights all query the database |
| ONRC CSV column mapping | **Verified against the real 08.07.2026 export.** Delimiter is `^`; every column mapped |
| ONRC parsing, filters, streaming | **Verified** — 94 unit tests, plus full runs over the real 690MB file |
| ONRC import end to end | **Verified** — 4.0M rows read, 11,597 companies written to Supabase |
| Email waterfall against real leads | **Verified** — `npm run enrich:emails`, 3 of 5 leads with a domain resolved, 45 → 54 |
| Role-address harvesting from prospect sites | **Verified** — 37 of 140 domains (26.4%), no key and no quota |
| `POST /api/v1/leads/[id]/enrich` | **Verified** — `npm run verify:emails`, 22 checks: RLS, 404s, re-run does not duplicate, score 45 → 54 |
| The contacts table with an address | **Verified in a browser** — status pill, "role address" label, both Enrich buttons, no overflow at 1280 or 375px |
| Domain discovery by name-guessing | **Verified as ineffective** — 0 of 55 on the live run, and the reason is structural |
| Brave Search / domain-search | **From documentation, never run.** Needs `BRAVE_SEARCH_API_KEY`; `BraveSearch.probe()` prints the raw payload |
| Hunter / Prospeo / PDL shapes | **From documentation.** Hunter is the most confident, Prospeo the least |
| Claude ICP inference end to end | **Never run** with a real key |
| Gmail send | Routes not written yet |

## Decisions that should not be relitigated

Each of these was made deliberately and has a cost attached to reversing it.

- **Cloudflare Workers, not Vercel.** Vercel's Hobby tier forbids commercial
  use; Cloudflare's free tier permits it. Consequences: no `node:crypto` (use
  WebCrypto), no `Buffer`, and outbound port 25 is blocked — which is why
  per-mailbox SMTP verification sits behind an unimplemented interface.
- **Drizzle for schema only.** Runtime access goes through PostgREST with the
  caller's JWT so RLS applies. A service-role connection at runtime would
  bypass the entire tenancy boundary.
- **`drizzle/policies.sql` is the tenancy boundary**, not application code.
  `orgs` deliberately has no insert policy for `authenticated` — org creation
  decides tenancy, so it belongs to the service role.
- **Org bootstrap is a route, not a `handle_new_user` trigger.** A trigger that
  throws fails signup inside GoTrue with no surfaced error; a route returns a
  status code you can read in the network tab.
- **No LinkedIn.** Engagement data needs a paid API or a terms-violating
  scraper. Where the reference product plots "invitations sent", this plots
  companies sourced and signals detected — things it can measure.
- **No reply tracking.** Reading a Gmail mailbox needs `gmail.readonly`, which
  Google classifies as **restricted**: an annual CASA Tier 2 assessment,
  roughly $540–1,000/yr. Sending needs only `gmail.send` and `gmail.compose`,
  which are *sensitive* — about ten days of verification, no fee. So reply rate
  stays at zero rather than being estimated, and deliverability is reported
  instead because it is actually measured.
- **No Apollo.** Its free and Basic plans include no API access at all; the API
  starts around $745/mo. This was checked, not assumed.
- **Pages never touch the database.** They read `src/lib/data/*`, which returns
  typed view models. That seam paid off exactly as intended: the accessors moved
  from fixtures to live queries and **not one page component changed**. The
  row-to-view-model mapping now lives in `src/lib/data/rows.ts`, pure and
  shared, for the same reason.
- **Romania warns, it does not block.** Law 506/2004 requires express prior
  consent for commercial email with no B2B exemption, and ANSPDCP fines run
  RON 5,000–100,000 or up to 2% of turnover. The app warns and records an
  acknowledgement; only the do-not-contact list blocks outright. The send
  decision stays with the user — that was their explicit call.

## Next steps, in order

Each unlocks the next. Do not skip ahead — step 4 produces nothing until step 3
has rows.

1. ~~**Verify auth.**~~ **Done.** For the record, what `db:setup` actually needs
   on Windows: `db:push` prompts for confirmation (`strict: true` in
   `drizzle.config.ts`) and cannot run without a TTY, so use `npm run db:migrate`
   — it applies the generated migration deterministically and records it in
   `__drizzle_migrations`.
2. ~~**Agent persistence.**~~ **Done and verified.** `npm run verify:agents`
   drives the real route with a real signed-in user: RLS applies, `org_id` in
   the body is ignored, arrays/numerics/jsonb round-trip, a null revenue bound
   stays null, and the free plan's one-agent cap returns 402. What remains is
   only the wizard's own path, which needs `ANTHROPIC_API_KEY` to infer an ICP
   before there is anything to save.

   *Original note:* `POST`/`GET
   /api/v1/agents` exist, on the **request-scoped** client only. The wizard's
   "Create agent" button posts the corrected ICP and routes to the new agent;
   `src/lib/data/agents.ts` reads the table outside demo mode. The mapping
   either side of PostgREST is pure and tested (`src/lib/agents/mapper.ts`).

   What is left is a single pass against a real database, once step 1 is done:
   sign up, create an agent from `/onboarding`, and confirm it comes back from
   `GET /api/v1/agents` and appears on `/app/agents`. Expect the plan cap to
   bite immediately — free is **one** agent, so the second create returns 402
   by design. Two things to watch on that first run: that `created_at` and the
   array columns narrow cleanly (the row helpers throw with a `db:types` hint
   if not), and that a second workspace cannot see the first one's agents.
3. **Seed the company table.** `AnafAdapter` searches the local `companies`
   table because ANAF has no search-by-CAEN endpoint — you can only look a
   company up once you know its CUI. Decision already taken: **narrow slice
   first** (one county or a handful of CAEN codes, a few thousand rows) to prove
   the chain, then scale with different flags.

   `scripts/import-onrc.ts` is written and runs today. Everything except the
   write is done: it streams the CSV, sniffs the delimiter, discovers the
   columns, parses, filters on `--caen` / `--county` / `--active-only`, and
   supports `--max-rows` / `--resume`. `writeBatch` throws on purpose — it is
   the one part that cannot be written honestly without a table to write to.

   **Download the CSV from data.gov.ro and run this first:**

   ```bash
   npm run import:onrc -- --file <path.csv> --dry-run
   ```

   It needs no database and no `.env.local`. It prints which column it matched
   to which field; if a column is named something the aliases do not cover, add
   the string to `ONRC_COLUMN_ALIASES` in `src/lib/sources/onrc/columns.ts` and
   nothing else changes. A rejection rate over 20% is reported explicitly,
   because that almost always means a column mapped to the wrong field rather
   than a dirty register.

   **Done.** The importer handles the real multi-file export: `OD_FIRME` joined
   to `OD_STARE_FIRMA` and `OD_CAEN_AUTORIZAT` on the trade-register number,
   with `N_CAEN` and `N_STARE_FIRMA` decoding the codes. Filter first, then
   join, so memory stays bounded by the slice rather than the file.

   ```bash
   npm run import:onrc -- --file od_firme.csv --stare od_stare_firma.csv      --caen-file od_caen_autorizat.csv --nomenclator . --county CJ --caen 62      --active-only
   ```

   `scripts/enrich-registry.ts` is written and has run: 11,438 of the 11,597
   companies came back from ANAF with VAT status, e-Factura registration, the
   inactive flag and the CAEN they actually file under.
   `scripts/import-representatives.ts` then added 11,217 decision-makers from
   `OD_REPREZENTANTI_LEGALI`. Both are re-runnable and idempotent.
4. ~~**First sourcing run.**~~ **Done.** `src/lib/pipeline/source-run.ts` behind
   `POST /api/v1/sourcing/run`, bounded and synchronous, cursor-paged. Runs
   entirely on the caller's session: leads and job_runs are tenant rows so RLS
   applies, while `companies` and `people` are shared reference data, so nothing
   here needs the service role.

   One lead per company rather than one per person — a company with four
   administrators is one opportunity, and mailing all four is how a sending
   domain acquires a reputation problem.

   *Original note:* `src/lib/pipeline/source-run.ts` plus
   `POST /api/v1/sourcing/run`, bounded to ~25 companies per invocation and
   **synchronous, not queued** — wiring five queue consumers before a single
   lead exists means debugging the queue and the pipeline simultaneously.
5. **Emails onto leads.** The current work, in four phases. Decisions already
   taken: a role address like `office@firma.ro` is an acceptable answer; free
   tiers now and paid later once it works; the deliverable is the **email**, so
   domain lookup appears below only as plumbing inside the email pipeline.

   **5a — connect the machinery.** ~~Write
   `src/lib/enrichment/enrich-lead.ts`: the missing caller that assembles
   `WaterfallDeps` from `MxChecker`, `CreditLedger`, `SupabaseUsageStore` +
   `FREE_TIER_LIMITS` and `allPeopleProviders`, feeds `knownRoleEmails` from a
   crawl of the prospect's domain, and persists `WaterfallResult.email` to
   `emails` with `leads.email_id` set. Persist misses too — that is what the
   table stores failures for, so a dead lookup is never paid for twice.
   Then `POST /api/v1/leads/[id]/enrich`, `npm run enrich:emails`, and give the
   two inert Enrich buttons an `onClick`.

   two inert Enrich buttons an `onClick`.~~ **Done, and the predicted number was
   the observed one: 45 → 54, three times out of three.**

   Two things worth knowing before continuing. Role addresses are harvested
   **per company** (`npm run enrich:emails -- --companies`), not per lead:
   `office@firma.ro` belongs to the company, so one fetch serves every lead
   there, now and later. And `leads.enriched_at` records misses, so a re-run
   does not re-spend on the same empty answers — pass `--force` when something
   has actually changed.

   `npm run verify:emails` drives the route the UI actually hits, with a
   throwaway tenant and three planted leads — one reachable, one with no domain,
   one with a domain and no address — and asserts the three different outcomes,
   that another workspace's lead reads as a 404 rather than a 403, and that a
   second run does not write a second `emails` row.

   **5b — widen the inlet: domains from search. ← next, and it needs a key from
   you.** This is the whole product now: enrichment converts at 26% once it has
   a domain, and 99% of companies have none, so every domain found is worth
   ~0.26 of an email. Name-guessing is measured dead (see the landmine); the
   structural reason is that a Romanian company's legal name is often not its
   brand, and **a search engine already knows that association**.
   **Built and waiting on a key.** `src/lib/enrichment/domain-search.ts` plus
   `--search` / `--measure` on `npm run discover:domains`. All of it is unit
   tested; none of it has run, because `BRAVE_SEARCH_API_KEY` is not set. Get a
   free key at <https://brave.com/search/api/> — 2,000 queries a month,
   commercial use permitted — put it in `.env.local`, then:

   ```bash
   npm run discover:domains -- --measure --limit 60
   ```

   That runs against companies whose domain the register **already** carries,
   so the right answer is known before the query is sent, and reports two
   numbers: recall (search proposed the right domain — the ceiling) and
   CUI-provable (the verifier would accept it — what a bulk run yields).
   Name guessing scored 47% recall and **0 accepted** on that same test.
   Only run the bulk pass if the second number is worth the quota.

   The load-bearing part is not the API, it is `AGGREGATOR_DOMAINS`: Romanian
   company-data sites (listafirme.ro, termene.ro, risco.ro and a dozen more)
   exist to rank first for exactly this query, and **every one of them publishes
   the fiscal code** — so the CUI check, which is otherwise proof of ownership,
   would confirm listafirme.ro as the website of all 11,597 companies.

   **5c — vendor fallback, metered.** Run the decision gate that was written for
   exactly this and has never run: `npm run spike:people -- --markets ro`. It
   probes quota before spending and refuses to start a provider it cannot
   finish. Hunter's free tier (~25 searches/month) is the one that reliably
   returns an email with a confidence score. Spend a credit only when the free
   steps fail *and* the lead scores above a threshold — 25 a month is scarce.

   **5d — verification. Deferred deliberately.** `MailboxVerifier` is an
   interface with no implementation and cannot have a local one: Workers blocks
   outbound port 25, so SMTP `RCPT TO` probing is impossible in-process. Nothing
   reaches `verified` without a vendor, which caps crawled role addresses at
   `found`. MX + `found` is enough to send.
6. **Gmail OAuth.** `/api/v1/auth/google/{start,callback}`, storing the refresh
   token encrypted via the existing `src/lib/outreach/crypto.ts`. Needs a Google
   Cloud project first.

Out of scope until the above works: queue consumers, cron handlers, the
unsubscribe endpoint, Copilot.

## Landmines

- **Contactability is 20% of the score and is currently always 0.** Hence the
  flat 45 on every lead. Do not go looking for a scoring bug — the scorer is
  right and the data is missing.
- **`emails` has no `org_id`.** It is shared reference data like `companies` and
  `people`: `authenticated` may select, only the service role may write. A
  request-scoped client silently inserts nothing. The tenant-scoped half of the
  relationship is `leads.email_id`, which does carry `org_id`.
- **`emails.status` allows `bounced`; `EmailStatus` in `waterfall.ts` does
  not.** The database enum is the wider one. Reconcile before persisting, or a
  bounce recorded by the send path becomes unrepresentable in the type that
  reads it back.
- **`APIFY_PEOPLE_ACTOR` is not in `src/lib/env.ts`.** `ProviderEnv` expects it
  and `getEnv()` drops it, so it is reachable only through raw `process.env` —
  meaning any app-side wiring sees Apify as unconfigured while a script sees it
  working.
- **`WaterfallDeps.providerLimits` is dead.** Limits come from the `UsageStore`
  (`FREE_TIER_LIMITS` passed to `SupabaseUsageStore`). Setting the field changes
  nothing, which is worse than it not existing.
- **`extractEmails` falls back to *every* same-domain address** when no prefix
  matches `ROLE_PREFIXES`. Fine for one-shot ICP analysis, wrong for bulk
  prospect crawling: a personal address harvested without consent is a
  different legal object from `office@`, and Law 506/2004 does not have a B2B
  exemption. Prospect crawling must be role-only.
- **RLS is testable offline now.** It used to be true that unit tests could not
  exercise the tenancy boundary. PGlite removed that constraint, so a policy
  change should come with a case in `src/lib/db/policies.test.ts`. Note the two
  shims it needs — Supabase supplies an `auth` schema with `auth.uid()`, and
  grants table privileges to `authenticated` before RLS narrows them. Without
  the grants every isolation assertion passes for the wrong reason, because the
  role cannot see the tables at all.
- **An empty env var is not an absent one.** dotenv parses `KEY=` as `""`, and
  an optional Zod string still fails `.min(1)` when present and empty — so a
  blanked key reads as malformed rather than missing. `.env.example` ships with
  eight such lines, so every fresh setup starts there. `present()` in
  `src/lib/env.ts` strips them before validation; do not bypass it.
- **Env validation must not couple unrelated subsystems.** `getEnv()` validates
  the whole schema and throws, so for a while a missing `ANTHROPIC_API_KEY`
  broke workspace creation, kept the app on demo data with a live database, and
  made `/api/v1/agents` claim there was no database. Provider keys are optional
  by design; anything that needs one checks for it and says so by name.
- **`db:types` needs Docker.** The Supabase CLI shells out to a container for
  `--db-url`. Without it the placeholder stays, which is survivable — that is
  what `src/lib/supabase/row.ts` is for.
- **`src/lib/supabase/types.ts` is a placeholder.** Every selected column
  arrives as `unknown`, which is why `src/lib/supabase/row.ts` exists to narrow
  at runtime rather than cast. Run `npm run db:types` once a project exists and
  the placeholder is replaced wholesale; the row helpers stay correct, just
  redundant.
- **Supabase free tier is 500MB.** The full Romanian register is roughly 4M rows
  and would exceed it. Hence the narrow-slice decision in step 3, and
  `npm run db:size` should be added to check the estimate against reality.
- **ANAF enrichment is rate-limited** to one request per 1.1s, 100 CUIs per
  request. Four million companies is ~12 hours unattended. `AnafClient`
  serialises through a promise queue that survives a rejected call.
- **`fetchRevenueGrowth` returns null for an unfiled year.** A missing filing is
  not zero revenue, and treating it as zero would invent a collapse.
- **Diff-based signals need two scans.** Tech-stack changes, pricing changes and
  hiring surges produce nothing on a first run, by design.
- **`sr-only` is `position: absolute`, and that leaks into layout.** Two bugs
  came from it. On a `<table>` the class does nothing useful — a table treats
  `width: 1px` as a minimum and expands to its content, so the accessible chart
  table stretched the document and every page carrying a chart scrolled
  sideways; it needs a `sr-only` **div** wrapper, which does honour the 1px.
  And with no positioned ancestor an `sr-only` span resolves against the
  document rather than its cell, so the one in the contacts table escaped a
  working `overflow-x-auto` container. Measure with
  `document.documentElement.scrollWidth > clientWidth`, not by eye.
- **Grid and flex items default to `min-width: auto`.** They refuse to shrink
  below their content, so a `truncate` inside never gets the chance to apply
  and the track resolves wider than its container. `[&>*]:min-w-0` on the
  container is the fix.
- **ONRC's delimiter is `^`, not `,` or `;`.** Nobody guesses that. It is also
  why it works: a caret never appears in a company name or address, so nothing
  needs quoting.
- **CAEN Rev 3 reassigned codes.** `6210` meant *scheduled air transport* in the
  1998 and 2003 revisions and means *software development* in the 2025 one;
  `6201` was software in 2008. So a bare code is meaningless without its
  version, and `N_CAEN.CSV` is the source of truth, not any hand-written table.
  Contamination in division 62 is currently negligible — 60 rows nationally
  against ~460k — but a division-level filter is version-blind by construction.
- **Half the register is struck off.** `radiată` is the single most common
  status (49%), so `--active-only` is not a nicety. Suspended companies
  (`întrerupere temporară`) are excluded too; `sediu expirat` is administrative
  and a trading company routinely carries it.
- **`companies.domain` is unique, but the register is not.** Romanian groups run
  several legal entities off one website. The importer gives the domain to the
  first claimant and leaves the rest null rather than dropping the constraint,
  which exists so a crawler and a registry import can recognise the same
  company.
- **Guessing domains from company names does not work. Measured, not assumed.**
  `npm run discover:domains` exists and its verifier is sound, but the yield is
  near zero and the reason is structural:
  - the correct domain is among the generated candidates **47%** of the time
    (137 companies whose real domain we know)
  - of registered domains, **42% do not resolve at all**
  - of those that do, the CUI appears on the page for about **29%**
  - compounded, that is single-digit percent — and 0 of 55 on the first live run
  The deeper problem is that **a Romanian company's legal name is often not its
  brand**: BASICSOFT SRL trades as codespring.ro, ACDM DIGITAL ONE as
  thebrightsession.com, MINDMAZE ROMANIA on its Swiss parent's mindmaze.ch. No
  amount of string manipulation recovers that association.
  What is worth keeping is the **verifier**: a company must publish its fiscal
  code on its own site, so `pageMentionsCui` is proof of ownership and is
  reusable for candidates from any source. The next attempt should get its
  candidates from a search API, which already knows the brand↔company link.
- **The `--measure` gate over-predicts by 3x, and cannot help it.** It scores
  the candidate source against companies whose domain **the register already
  carries** — that is the only place a known-good answer exists. But those are
  exactly the companies that bothered to register a website, and they turn out
  to be far easier: measured 7.5% CUI-provable on that sample, **2.4% on a live
  run over 250 companies the register has no website for**. The gate is still
  worth running — it correctly ruled name-guessing out at 0% — but read its
  number as a ceiling, not a forecast.
- **Domain search is not worth its quota at the current yield.** 250 Brave
  queries produced 6 domains, which at the measured 26% harvest rate is about
  1.5 email addresses — against a free tier of 2,000 queries a month. Importing
  the register's own website column produced **5,400 domains for zero queries**.
  Search is the right tool only for a company somebody specifically cares about,
  never as a bulk pass.
- **A company's CUI is usually NOT on its website, whatever the law says.**
  The whole verifier rests on "a Romanian company must publish its fiscal
  code", and that is the legal position, not the observed one. Measured over 60
  companies whose real domain the register already carries: **16 unreachable,
  5 with the CUI on the home page, 4 only on a deeper page, 35 nowhere we
  looked.** So the proof step, not the candidate source, is now the binding
  constraint. Checking `/contact` as well as `/` tripled the bulk yield
  (2.5% → 7.5%); `PROOF_PATHS` in `scripts/discover-domains.ts` is where to add
  more if someone finds a page type that pays.
- **A CUI-anchored citation is not proof, and was tested as one.** "A registry
  aggregator, on a page naming this exact fiscal code, names this domain as the
  company's website" sounds like third-party attestation, and it is not
  circular the way a name match is. It is still only **60% precise** — 25%
  coverage, 9 right and 6 wrong out of 15, including `aliria.com` for
  `aliria.net` and `elogicode.ro` for `logicode.ro`. Near-misses are the
  dangerous kind. It stays a candidate *source*; `pageMentionsCui` stays the
  only thing that accepts.
- **Brave rejects `country=RO`.** Its enum has 37 countries and Romania is not
  among them; passing it 422s the whole request rather than degrading. Only
  discovered by calling the API. `search_lang=ro` is a different parameter and
  does accept it.
- **Searching for a Romanian company returns registry aggregators, not the
  company — and that turns out to be the good news.** The aggregator result is
  where the answer lives: `listafirme.ro`'s own title for BASICSOFT SRL reads
  *"Website BASICSOFT SRL din Cluj Napoca https://codespring.ro"*. Excluding
  those hosts as destinations while **mining domains out of their titles and
  snippets** (`citedDomains`) is what makes search work; without it the same
  query yields `basicsoft.us`, an unrelated American company.
  The exclusion half is still load-bearing: every one of those sites displays
  the fiscal code, so `pageMentionsCui` — proof of ownership for a real company
  site — would confirm listafirme.ro as the website of all 11,597 companies.
  `AGGREGATOR_DOMAINS` is not a quality filter and must not be trimmed for
  tidiness; several entries were added only after showing up in live results.
- **A name match is not evidence.** The first version accepted a domain when the
  page contained the company name, and produced `business.com` for Z BUSINESS
  SRL and `all.ro` for ALL BEFORE SRL. The name is what the candidate was
  generated from, so matching it is near-circular. A wrong domain is worse than
  none — it poisons email inference, tech-stack detection and every signal
  derived from them, and nothing downstream would suspect it.
- **Only ~1% of registered companies list a website.** 140 of 11,597 in the Cluj
  slice. Everything domain-based — crawling, tech-stack signals, email pattern
  inference — therefore reaches a small minority from the registry alone.
  Finding domains for the rest is an unsolved problem, not a wiring gap.
- **ANAF 404s for a CUI it does not know.** Not an empty result — a 404. The
  client treats that as "not found" now; before, one unregistered CUI threw and
  killed a batch. A meaningful share of registry rows are not registered for
  tax, so this is the normal case, not an edge one.
- **PostgREST caps a select at 1,000 rows, silently.** No error, no truncation
  flag, just a short array. The first full enrichment run reported success
  having touched a tenth of the slice. Anything reading more than 1,000 rows
  must page with `.range()`.
- **Authorised CAEN is not actual CAEN.** ONRC lists everything a company may
  do; ANAF reports what it files under, and they routinely disagree — companies
  authorised for software turning out to be electrical contractors or
  architects. Enrichment overwrites `caen` with ANAF's value because that is
  the one describing the real business.
- **`OD_REPREZENTANTI_LEGALI` carries birth data; we deliberately do not.** Date
  and place of birth are present for ~89% of natural persons. They are read to
  tell a person from a company and then discarded — name plus date and place of
  birth is a strong identifier for a private individual, and none of it is
  needed to send a business email. Do not "improve" the importer by storing it.
- **Most representatives are not decision-makers.** Insolvency practitioners
  (`lichidator`, `administrator judiciar`, and variants) outnumber
  administrators in the file. Their presence is a distress signal worth having
  in the signals engine, but they are not people to email.
- **A "representative" is often a company.** Foreign parents administer Romanian
  subsidiaries, so `Sarl`, `Kft`, `Zrt`, `Sro` and friends appear alongside
  `SRL`. Romanian sole traders (`PFA`, `Întreprindere Individuală`) are the
  opposite case — a real person whose registered name carries a suffix that
  should be stripped, not rejected.
- **A local midnight is the previous day in UTC.** `toISOString().slice(0, 10)`
  is the obvious way to key a day and it is wrong here: Romania is UTC+2/+3, so
  the axis labels and the run buckets landed on different days and every chart
  series read as flat zero. Use the local-date helpers in `dashboard.ts` and
  `insights.ts`.
- **Log `error.message`, not the error object.** A PostgrestError prints as `{}`
  through `console.error("...", { error })`, which is how a missing column
  turned into an unexplained empty overlay.
- **A PostgREST `select` string must be one literal.** supabase-js reads it at
  the type level, and `"a" + "b"` widens to `string`, which turns every row into
  `GenericStringError` and fails `typecheck` with a message that names neither
  the cause nor the file's real problem. Keep the column list on one line.
- **`LayoutProps<"/">` in `src/app/layout.tsx` comes from `.next/types`.** A
  fresh checkout fails `typecheck` until `next build` or `next dev` has run
  once. Nothing is wrong with the file.
- **`AGENTS.md` is regenerated by `next dev`.** Deleting the block from a diff
  only recreates it as an uncommitted change; commit it with the work instead.
