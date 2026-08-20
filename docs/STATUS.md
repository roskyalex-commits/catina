# Where this project is

Written for whoever (human or agent) picks this up next, so nothing has to be
re-explained or re-derived. Update it when the answers change.

- **Branch:** `main`, pushed to `github.com/roskyalex-commits/catina`.
- **Last commit:** `7ccdcdb` — industries are the vocabulary, NACE the derivation.
- **Green:** 791 tests, clean `typecheck` and `lint`.
- **Data:** **17,156 companies** (5,406 with a website), **29,551
  decision-makers**, **1,559 harvested email addresses**, **248 companies
  scanned for signals**. `/app` renders **911 leads**; **35 carry a real
  address**, **54 carry a signal**, and the best now scores **76** rather than
  the old flat 45.
- **Two structural gaps are closed.** Contactability (20% of the score) and
  signals (35%) both used to contribute exactly zero. Both now work. Read
  "The two constant zeros" below before anything else.
- **The ICP now means what a user means by it.** Keyword and competitor signals
  fire on a *first* scan, against the page the scan already fetched. Measured
  over the 82 companies whose site was actually read: `keyword_on_site` **41.5%**,
  `competitor_tech` **19.5%** — against **0%** for hiring and news. Rescoring
  moved **48 leads by an average of 13.3 points**.
- **Current work: the ICP and the wizard around it.** Plan at
  `C:\Users\rosky\.claude\plans\alright-let-s-for-keen-pascal.md`.
  Phases 0–3 are done; **Phase 4 (the five-step wizard) is next**.

## The two constant zeros

Every lead used to score exactly 45, and it was not a coincidence — it was a
ceiling. `scoreLead` weights ICP fit 0.45, signals 0.35, contactability 0.20.
With no email, contactability contributes **exactly zero**, so a perfect-fit
lead with no signals lands at 0.45 × 100 = 45.

Enrichment was never the problem. Once a company has a domain, **28% of them
publish a role address** and the waterfall resolves it for free. The funnel was
starved one step earlier: only 140 of 11,597 companies had a website on file.

**Three ways of getting domains, measured against each other:**

| Approach | Domains | Cost |
|---|---|---|
| Guess them from the company name | **0** of 55 | free |
| Brave search over leads | **6** of 250 (2.4%) | 250 of 2,000 monthly queries |
| **Import the register's own website column** | **5,400** | free, no API |

The third one won by three orders of magnitude, and the data had been sitting
in `od_firme.csv` the whole time. Scanning all 4,019,034 rows: **11,050
companies carry a usable website**, 5,700 of them still trading. Nobody needs
to guess or search for those.

What that produced, end to end and measured at each step:

| Step | Result |
|---|---|
| Companies with a website, nationally | **11,050 of 4.0M rows** — 0.27% |
| Still trading, imported | **5,700** |
| Publishing a role address | **1,525 of 5,400** — **28.2%** |
| Leads sourced from contactable companies | **153** |
| Leads that resolved to an address | **35** |
| Score movement on a hit | **45 → 54**, every time |

The 54 is a role address (`office@`, `contact@`) at 0.55 confidence with the
0.7 role-address penalty. A verified personal address would reach ~65, which
needs either a vendor (step 5c) or mailbox verification (step 5d).

**What still limits it.** 5,406 companies have a domain out of 17,156, and the
agent's CAEN filter narrows that to 199. Widening the ICP, or importing more of
the register, moves the number far more than any enrichment work will.

### The second zero: signals, 35% of the score

The same failure, one component over and three times the weight. `SignalScanner`,
seven implemented sources and the `signals` table were complete and **had no
caller** — `sourceRun`'s `findSignals` dep was never supplied, so every real lead
scored signals = 0. That is why the flat scores were *exactly* 45 and *exactly* 54.

The loop now closes: `npm run scan:signals` → `signals` → `npm run rescore:leads`.
First run moved 8 leads and produced the first score to break the pattern, **63**,
on a lead carrying both an email and a signal.

**What the first run actually found, and it matters:**

| Source | Ran on | Signals |
|---|---|---|
| `hiring` | 159 | **0** — a five-person SRL has no careers page |
| `news` | 165 | **0** — Google News does not cover small Romanian companies |
| `onrc_new` | 165 | 3 |
| `anaf_growth` | 1 | 1 |
| `tech_stack`, `pricing_page` | 0 | skipped — need a previous scan to diff |

So the sources that exist produce **almost nothing for Romanian SMBs**.

### Where the signal actually was

The prediction above was that `keyword_on_site` and `competitor_tech` would be
the productive sources, because both fire on a *first* scan with no diff and both
read a page the scan already fetched. That is now measured rather than predicted.

Over **82 companies with a domain whose site was actually read**:

| Source | Companies | Rate | Cost |
|---|---|---|---|
| `keyword_on_site` | **34** | **41.5%** | none — reads the shared snapshot |
| `competitor_tech` | **16** | **19.5%** | none — reads the shared snapshot |
| `newly_registered` | 2 | 2.4% | none — reads the row |
| `tech_stack_added` | 1 | 1.2% | needs a previous scan |
| `hiring_surge` | **0** | 0% | one HTTP request |
| `funding_news` | **0** | 0% | one HTTP request |
| `keyword_in_news` | **0** | 0% | one HTTP request |
| `competitor_mention` | 0 | 0% | none, but nobody has named a text-only competitor |

**The two free sources outproduce the five paid-in-latency ones by 50 to 1.**
Rescoring moved **48 leads by an average of 13.3 points**, and the top lead went
**54 → 76** on a competitor detection plus a keyword match plus an email. The
score distribution is no longer flat.

Two caveats worth carrying forward. `competitor_mention` has never fired because
no agent has named a competitor without a detectable marker — it is untested
against real data, not disproven. And **site reachability is a coin flip**: 82
sites read against 83 unreachable, so every web-derived rate above is really
"41.5% of the half we can read".

The competitor ceiling is knowable in advance, from `company_scans.tech_stack`
over the sites we have fingerprinted: WooCommerce **19.4%**, PrestaShop 4.2%,
Magento 2.8%, HubSpot 2.8%. A seller displacing e-commerce platforms has about a
quarter of every readable site as a target; one displacing HubSpot has one in
thirty-five. The wizard's competitor picker should say so rather than let a user
name something with no coverage and conclude the product is broken.

### Keyword→company discovery does not work here, and that is now measured

The plan's other half was sourcing *from* a keyword: search the web for a topic
and turn the results into companies. `npm run measure:keyword-sourcing` spent 28
Brave queries on four keywords and settled it.

| | |
|---|---|
| Distinct non-aggregator `.ro` hosts found | **82** |
| Of those, joinable to a row in `companies` | **2** |
| Real `.ro` businesses we hold no registry row for | **80** |
| Fresh companies per 100 queries | **7.1** (gate was 15) |

The channel finds Romanian businesses perfectly well — about three per query.
The problem is the join. Cătină sources from a registry, and a domain with no
`companies` row has no CUI, no administrator and no route to a contact, so 80 of
those 82 are discoveries nobody can act on. Worse, **both of the two that joined
are ERP *vendors*, not ERP buyers** — a topic query returns the sellers of the
topic, which is the same failure mode `keyword_on_site` has to be read for.

So keyword search re-ranks companies we already hold rather than finding new
ones, which is exactly what `keyword_on_site` already does for free and without
a quota. Nothing was wired to it. The script stays as the record.

Also learned the hard way: **Brave returns zero results for a TLD-only `site:`
operator.** `"e-factura" firma site:.ro` came back empty while `"e-factura" firma`
returned ten. The country restriction has to be applied on our side.

## CAEN is four registers wearing one column

`companies.caen` looks like a single vocabulary and is not. The ONRC nomenclator
declares **four** CAEN revisions — 1998, 2003, 2008 (NACE Rev. 2) and 2025
(NACE Rev. 2.1) — and two of them are live in our data at once, because ANAF
files the 2008 codes and ONRC now lists the 2025 ones. Nothing records which
revision a row came from.

The 2025 revision renumbered heavily:

| Activity | CAEN 2008 | CAEN 2025 |
|---|---|---|
| Custom software | `6201` | `6210` |
| IT consultancy | `6202` + `6203` | `6220` (merged) |
| Other IT services | `6209` | `6290` |
| Data processing, hosting | `6311` | `6310` |
| Web portals | `6312` | `6391` — which meant *news agencies* in 2008 |

**2,263 rows carry `6201` and 2,714 carry `6210`. Same activity.** An industry
that lists one and not the other silently halves its own reach, which is why
`industry-definitions.ts` holds *prefixes* and `npm run build:industries`
expands them against the nomenclator per revision. Measured against the live
database, the model's hand-written software list missed **758 companies
(+13.1%)** the derived one catches.

**CAEN 2025 abolished the e-commerce class.** This is the finding to remember.
`4791` meant "retail via mail order or the Internet" under CAEN 2008 — it *was*
the code for an online shop, and 344 of our companies still carry it. NACE
Rev. 2.1 stopped classifying sellers by *how* they sell, reassigned `4791` to
"intermediation in non-specialised retail", and **introduced no replacement**.
So "e-commerce" becomes progressively undiscoverable from the register, and the
reliable way to find a webshop is the platform on its site — Shopify,
WooCommerce, PrestaShop, Gomag and MerchantPro are all in `TECH_MARKERS`, and
`competitor_tech` already reads them. Do not go looking for a 2025 code. There
is not one.

CAEN itself stays. It is still what the sourcing query filters on and still the
axis no international tool has. What changed is where the codes come from: an
enum of 37 industries the model picks from, expanded through the official
nomenclator, instead of the model reciting four-digit numbers into a SQL `IN`.

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

Ops scripts, in the order a fresh database needs them: `import:onrc` →
`import:reps` → `enrich:registry` → `enrich:emails --companies` → `source` →
`enrich:emails` → `scan:signals` → `rescore:leads`.

`build:industries` is not part of that chain — it regenerates
`src/lib/icp/nace-codes.generated.ts` from ONRC's `n_caen.csv` and only needs
running when ONRC publishes a new export or an industry prefix changes. Use
`--check` in CI to catch a stale generated file.

`scan:signals` takes `--keywords` and `--competitors` to calibrate a list
without first writing it to the agent, and `--all-sources` to opt into the two
Google News sources it otherwise leaves off. `measure:keyword-sourcing` is a
spike, not part of the chain — it is hard-capped at 200 Brave queries and its
verdict is already recorded above.

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
| Signal scan → `signals` → rescore | **Verified** — 248 companies, 61 signals, **48 leads rescored, +13.3 points average, top lead 76** |
| `keyword_on_site` against real Romanian sites | **Verified as the best source we have** — 34 of 82 readable sites (41.5%), zero extra requests |
| `competitor_tech` against real Romanian sites | **Verified** — 16 of 82 (19.5%), fires on a first scan with no diff |
| `competitor_mention` | **Never fired** — no agent has named a competitor without a detectable marker. Untested, not disproven |
| Keyword → company discovery via web search | **Verified as unusable here** — 82 hosts found, **2** joinable, and both were vendors not buyers |
| Brave Search | **Verified live** — 59 queries spent. A TLD-only `site:` operator returns **zero** results |
| Industry → CAEN derivation | **Verified against the live database** — the model's hand-written software list missed **758 companies (+13.1%)** the nomenclator-derived one catches |
| CAEN 2025 abolished the e-commerce class | **Verified in the official nomenclator** — `4791` was reassigned and there is no replacement |
| The seven original signal sources against real Romanian SMBs | **Verified as thin** — hiring 0/159, news 0/165, `keyword_news` 0/82. See the table above |
| `company_scans` RLS | **Verified** — offline in `policies.test.ts`: any user reads, only the service role writes |
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
- **No LinkedIn *yet*, but the slot is built.** Engagement data needs a paid API
  or a terms-violating scraper, and there is no free legal substitute — so it
  stays off. The user's instruction is explicit that this will be bought once
  the product is working, and that more paid data will follow, so the seam is
  built and empty rather than absent:

  | Piece | Where |
  |---|---|
  | The vendor contract | `src/lib/signals/providers/types.ts` |
  | Where a vendor gets added | `src/lib/signals/providers/registry.ts` — one line |
  | Budget, isolation, evidence rules | `src/lib/signals/sources/person-engagement.ts` |
  | Signal types it emits | `person_engaged_topic`, `person_engaged_competitor` |
  | Person resolution | `signals.person_id`, `Signal.personLinkedinUrl`, `upsertSignals` |

  Three rules hold there because they are expensive to get wrong once money is
  involved: budget is checked **before** the call against the same `CreditLedger`
  the email waterfall uses (one accounting system, not two); a lookup is charged
  even when it returns empty or throws, because the vendor charges for it; and a
  signal with no evidence URL and no person is **dropped**, because paying for
  data is not an exemption from the rule that a user can click through to the
  source. Connecting a provider changes nothing downstream of `SignalScanner`.

  Until then the signal picker renders it as a visible "Not connected" row
  carrying the reason, so the two Gojiberry categories with no free equivalent
  are stated rather than quietly missing. `PAID_PROVIDER_CATALOGUE` in
  `providers/types.ts` lists what each purchase would actually unlock.
- **Where the reference product plots "invitations sent"**, this plots companies
  sourced and signals detected — things it can measure.
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
6. **Signals and a real ICP — the current work.** Full plan at
   `C:\Users\rosky\.claude\plans\alright-let-s-for-keen-pascal.md`.
   The complaint that started it: the ICP is driven by CAEN codes, which are an
   industry proxy, not an ideal customer profile. It should match on needs,
   keywords and competitor usage — the way Gojiberry does, whose flow is
   Sources → Signals → Target → Preview → Outreach.

   Decisions taken, do not revisit: **no LinkedIn now** (build a visible empty
   slot for person-level engagement and match the intent with free EU-legal
   sources meanwhile); **EU-ready model, RO data** — CAEN is Romania's
   implementation of NACE, so the same codes target any EU registry the day one
   is imported.

   ~~**Phase 0** — one site read per scan, `DETECTABLE_TECH` exported,
   `SignalScanContext` widened.~~ **Done** (`b391988`).

   ~~**Phase 1** — wire the scanner end to end.~~ **Done** (`f23b4e3`):
   `company_scans`, `src/lib/signals/repository.ts`, `anaf-row.ts`,
   `src/lib/pipeline/signal-scan.ts`, `scripts/scan-signals.ts`,
   `scripts/rescore-leads.ts`, and `findSignals` supplied in both callers.

   ~~**Phase 2** — keyword and competitor signals.~~ **Done** (`41323a9`), and
   it was the important one. `keyword_site`, `competitor_tech`,
   `competitor_mention` and `keyword_news`; `competitorTech` / `competitorNames`
   on the ICP and on `agents`; the `PersonSignalProvider` seam pulled forward
   from Phase 5. Measured at **41.5%** and **19.5%** against **0%** for hiring
   and news — see "Where the signal actually was" above. Keyword→company
   *discovery* was measured and rejected; the script stays as the record.

   ~~**Phase 3** — industries → NACE.~~ **Done** (`7ccdcdb`). 37 industries in
   `industry-definitions.ts`, expanded to real classes by
   `npm run build:industries` against the ONRC nomenclator. `industryKeys` is
   load-bearing, `caenCodes` is derived-but-overridable, and Claude is no longer
   asked for a code. See "CAEN is four registers wearing one column" above.

   **Phase 4 — the wizard, five steps. ← next.** Sources / Signals / Target / Preview /
   Outreach, including the signal picker (**no UI has ever written
   `enabledSignals`**) and a lead preview with deterministic reject-to-refine.

   ~~**Phase 5 — the LinkedIn seam.**~~ **Done early** (`41323a9`), pulled
   forward because Phase 4's picker needs the catalogue entry. See the
   "No LinkedIn *yet*" decision above for the five pieces and the three rules.
   What is *not* done and does not need a provider: **`contact_job_change` from
   ONRC representative diffs.** A person replacing another as administrator is a
   job change — dated, evidence-linked, and stronger than a LinkedIn headline
   because it is a legal filing. Blocked only on having a second ONRC export to
   diff against; `import-representatives.ts` is already idempotent.
7. **Gmail OAuth.** `/api/v1/auth/google/{start,callback}`, storing the refresh
   token encrypted via the existing `src/lib/outreach/crypto.ts`. Needs a Google
   Cloud project first.

Out of scope until the above works: queue consumers, cron handlers, the
unsubscribe endpoint, Copilot.

## Landmines

- **An empty `enabled_signals` means *every* source, including the expensive
  ones.** `selectSignalSources` treats an empty list as "run everything", which
  is right for a library and wrong for an ops script — and no UI has ever
  written that column, so every live agent has it empty. A plain
  `npm run scan:signals` therefore opted into *both* Google News sources at up
  to 20s each per company when Google throttles, turning a scan that should take
  minutes into the better part of an hour. `scripts/scan-signals.ts` now falls
  back to `DEFAULT_ENABLED_SIGNALS` and `--all-sources` is how you ask for the
  rest on purpose. **The Phase 4 wizard must always write an explicit list.**
- **A short keyword needs case-sensitive matching, or it poisons everything.**
  The live agent targets `IT`. Folded to lower case and matched whole-word, that
  hits the English word "it" several times a paragraph on the English-language
  homepage of every Romanian software company in the register — every one of
  them would have scored a keyword signal, and the signal component would have
  gone from a constant zero to constant noise. `keywordPattern` in
  `src/lib/signals/sources/text.ts` matches keywords of ≤4 characters that are
  all-capitals case-sensitively, and everything longer case-insensitively. Do
  not "simplify" that back to one flag.
- **A keyword hit finds sellers as readily as buyers.** The crawler only fetches
  home, about, pricing, products, solutions and customers — there is no blog and
  no careers page — so a company matching your keyword may be a competitor
  rather than a prospect. Measured directly: both of the two companies that
  keyword *search* surfaced and that joined to the register were ERP vendors.
  The mitigations are `exclusions`, and Phase 4's reject-to-refine. The evidence
  snippet exists so a user can tell the difference in one glance.
- **Site reachability is a coin flip, and it is the denominator for everything
  web-derived.** 82 sites read against 83 unreachable on the same run. Every
  web-source rate in this document is a rate over the half we can read, and the
  cheapest way to double any of them is to make more sites readable, not to add
  another source.
- **The ANAF financials pass was never run.** Only **29 of 17,156** companies
  have both `revenue_ron` and `revenue_prev_ron`, so `anaf_growth` — the signal
  no international tool can match — has almost nothing to work with.
  `enrich-registry.ts` did the VAT pass and skipped financials (they are one
  request per company per year, the slow part). Running it for the 5,406
  companies with a domain is roughly 1.7 hours and would make the strongest
  Romania-only signal actually fire.
- **Regenerate `nace-codes.generated.ts` whenever ONRC publishes a new export.**
  `npm run build:industries -- --file n_caen.csv` rewrites it; `--check` fails if
  the committed file is stale, which is what CI should run. The nomenclator is
  not in the repo. A new CAEN revision would land silently otherwise, and the
  first symptom would be an industry quietly halving its reach.
- **Never derive CAEN codes in the query path.** `normaliseIcpIndustries` runs at
  exactly two boundaries — after Claude produces an ICP, and when the wizard
  posts one back. Deriving at query time would let a stored agent and a live
  query disagree about what the agent targets, and the only way to find out
  would be to run it.
- **`caenCodesOverridden` is set on every pre-existing agent**, by the backfill in
  `0004_premium_patriot.sql`. Their codes came from a model rather than from an
  industry choice, and re-deriving would change what a working agent targets. A
  user opts back into derivation by clearing the flag — nothing does it for them.
- **`caen_label` is wrong for a large share of rows, and CAEN revisions are
  mixed.** `enrich-registry.ts:97` overwrites `caen` with ANAF's code and never
  touches `caen_label`, which `import-onrc.ts:505` set from ONRC's *authorised*
  activity. Measured: code `7311` (advertising agencies) carries six different
  labels including software ones, and **both `6201` and `6210` hold software
  companies** — ANAF files Rev. 2, ONRC lists Rev. 3. Consequences: never key
  anything off `caen_label`. The industry→code half of this is now handled —
  `build-industries.ts` expands prefixes against every live revision — but the
  label column itself is still wrong and still un-repaired. Recompute it from
  `caen` after enrichment, or null it.
- **`signals_dedupe_idx` is UNIQUE on `dedupe_key` globally, not per company.**
  The news source keys only on the article guid, so one article naming two
  companies would have the second write steal the first company's row — silently.
  `scopedDedupeKey` in `src/lib/signals/repository.ts` prefixes the company id
  centrally. Do not push that responsibility back down into the sources; the
  point is that a source author cannot get it wrong.
- **Scan state is state, not a by-product.** `company_scans.tech_stack` is what
  the *next* scan diffs against, so the scan reads the site itself rather than
  relying on whichever source happens to want it. Recording it only as a side
  effect meant a `--no-web` pass stored an empty stack and the scan after that
  reported every technology as newly added.
- **`fetchSiteSnapshot` has a much stricter reachability bar than
  `fetchRoleEmails`.** It needs 200+ characters of real text on some page, so
  JavaScript-only sites fail: **84 of 165** were unreachable to the scanner
  against ~27% during the email harvest. Same sites, different verdict — do not
  compare the two numbers.
- **`policies.test.ts` used to apply only migration `0000`.** It had been
  asserting RLS against a schema several migrations behind, and only broke when
  `policies.sql` referenced a table a later migration created. It now applies
  every `drizzle/NNNN_*.sql` in order and names the tables it expects rather
  than counting them.
- **Four ICP fields do nothing.** `industries` and `companyTypes` are never read
  by scoring or by any query — `industries` is produced by Claude, edited in the
  wizard, stored, and read by nothing. `keywords` affects sourcing (a name-ILIKE
  fallback) but not the score. `caenCodes` does all the real work. Phase 3 of the
  current plan inverts that.
- **No UI has ever written `enabledSignals`.** The agent schema defaults it to
  four sources and `agents/[id]/sources/page.tsx` displays On/Off pills that
  cannot be clicked. Two code comments refer to a signal picker "in onboarding
  step 4"; there is no such step.

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
- **Only 0.27% of registered companies list a website — so import exactly
  those.** 11,050 of the register's 4,019,034 rows carry one, and they are the
  only rows anything domain-based can work with: crawling, tech-stack signals,
  email inference. `--has-website` is not an optimisation, it is the difference
  between 140 usable companies and 5,400. Finding domains for the *rest* is
  still unsolved and, at 2.4% from search, not currently worth paying for.
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
