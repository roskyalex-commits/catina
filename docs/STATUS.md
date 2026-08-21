# Where this project is

Written for whoever (human or agent) picks this up next, so nothing has to be
re-explained or re-derived. Update it when the answers change.

- **Branch:** `main`, pushed to `github.com/roskyalex-commits/catina`.
- **Last commit:** `5a97361` — the outreach system, wired to the app.
- **Green:** 1,023 tests, clean `typecheck` and `lint`, plus 22 live checks in `verify:onboarding` and 4 in `verify:llm`.
- **Data:** **17,156 companies** — 5,406 with a website, **16,850 (98.2%) with a
  street address** and **12,097 (70.5%) with a phone number** — ANAF stores an
  empty string, not null, for the other 4,753, so `not null` overcounts it.
  9,455 enriched from ANAF. **29,551
  decision-makers**, all with `first_name`/`last_name` resolved. **1,788 leads**
  across two agents, **1,094 signals** on 788 companies, best lead **91**.

### The one number that matters, and it is not a data-source problem

Of 1,788 leads:

| | | |
|---|---|---|
| name + company + **a real signal** | 1,788 | **100%** |
| phone | 1,350 | 75.5% |
| domain | 1,040 | 58.2% |
| **any email** | 165 | **9.2%** |
| named email | 30 | 1.7% |
| **verified email** | **8** | **0.4%** |

Every lead already has a named decision-maker and a clickable piece of evidence
about why now. The entire bottleneck is turning a domain into a verified
address, and that is blocked on **verification credits** — not on missing data.

**Three vendors were evaluated and all three came back "no" or "not yet".** Do
not re-open these without reading "What was ruled out, and why" below: the
answers were measured, not assumed, and two of them saved money.
- **Two structural gaps are closed.** Contactability (20% of the score) and
  signals (35%) both used to contribute exactly zero. Both now work. Read
  "The two constant zeros" below before anything else.
- **The ICP now means what a user means by it.** Keyword and competitor signals
  fire on a *first* scan, against the page the scan already fetched. Measured
  over the 82 companies whose site was actually read: `keyword_on_site` **41.5%**,
  `competitor_tech` **19.5%** — against **0%** for hiring and news. Rescoring
  moved **48 leads by an average of 13.3 points**.
- **The ICP analysis has now actually run**, on a real Gemini key, against
  smartbill.ro — the last never-executed path in the product. Either
  `ANTHROPIC_API_KEY` *or* `GEMINI_API_KEY` works; Claude wins when both are
  set. `npm run verify:llm` answers whether a key works before you go looking
  at the crawler.
- **The wizard runs end to end.** Sources → Signals → Target → Preview →
  Outreach, verified in a browser against a live site. See "What the wizard
  actually produced" below.
- **The plan is finished.** `C:\Users\rosky\.claude\plans\alright-let-s-for-keen-pascal.md`,
  Phases 0–5. All that remains of Phase 5 is `contact_job_change` from ONRC
  representative diffs, which needs a second export to diff against.
- **Named contacts, without LinkedIn.** The competitor finds a person on
  LinkedIn and constructs `first.last@` at their employer. We already hold the
  people — 29,551 administrators, from a legal filing rather than a scrape —
  and the address generator was already written. Read "Real people, real
  addresses" below: the headline is that **every address it would have built
  was wrong**, because ONRC writes surnames first and the generator read them
  last.
- **The ANAF financials pass is done, and re-scored.** 9,455 companies
  enriched, 4,216 with a 2025 revenue figure. `scan:signals --no-web --tier a`
  turned those filings into **119 new signal rows** (180 total, from 64), and
  `rescore:leads` moved **110 leads**. Best lead **79**, 31 above 60, 11 above
  70 — and **18 leads disqualified by a distress signal**, which is the system
  correctly refusing to spend outreach on companies being wound up.
- **Guess-and-verify is built.** Per-company inference only fires on ~2.5% of
  domains, so for the other 97.5% the waterfall now guesses the convention and
  lets the mailbox settle it — the competitor's mechanism, done with a
  verification step. Two economies keep it affordable on 600 checks a month: a
  catch-all verdict stops the loop (further guesses return the identical
  non-answer), and `unknown` stops it too (the check failed, not the address).
- **The suppression list is wired.** `guardSend` and `evaluateCompliance` both
  took `suppressed: boolean` and neither had ever been handed a real value.
  `src/lib/outreach/suppressions.ts` reads and writes the table, a domain entry
  shadows every address under it, and the lookup **fails closed**.
- **Domain discovery by search is dead too.** Brave scored 8.3% on companies
  that already had a domain and **0.1% on the 746 lead companies that do not**.
  The first number was measured on a population biased toward findable
  companies and does not transfer. See "Domains are the real ceiling".
- **Outreach is built and runs.** Draft → queue → guard → Gmail, proven against
  the real database as far as Google's own hop. Read "The outreach system"
  below and `docs/OUTREACH.md`. **Still nothing sent** — the last step needs a
  Google Cloud OAuth client, which is 15 minutes and cannot be automated.
- **Next, in order of value per euro:**
  1. **A Google Cloud OAuth client — free, 15 minutes, and the last blocker.**
     Everything either side of it is built and tested. `docs/OUTREACH.md` has
     the steps; the scopes are deliberately all *sensitive* and none
     *restricted*, which avoids a $540–1,000 annual CASA audit.
  2. **Reoon paid tier, $9/month.** The free allowance is spent. 875 leads have
     a domain and no email; at the 60% hit rate measured on the mid-market
     segment that is **~525 more contactable leads**. Measured, not guessed:
     the first drafting run skipped **360 of 400 leads for `no email address`**,
     which is the same bottleneck seen from the other end.
  3. **Phone is a channel nobody is using.** **1,350 leads carry a phone**, free
     from ANAF, needing no domain and no verification — 8× more reachable
     contacts than email, and the only route for the 748 leads that will never
     have one. Romanian SMB sales is phone-led. The lead row and its detail now
     show the number as a `tel:` link; nothing yet treats it as a *channel*
     (no call list, no logging, no disposition).

## New commands this session

```bash
npm run build:given-names     # regenerate the RO given-name lexicon
npm run backfill:names        # split people.full_name into halves
npm run harvest:patterns      # learn each company's email convention
npm run outreach:draft        # leads -> drafted messages (start with --dry-run)
npm run outreach:send         # drafted messages -> Gmail (start with --dry-run)
npm run measure:patterns      # the convention distribution + guess order
npm run measure:firme         # gate a FirmeAPI subscription (needs free key)
npm run measure:brightdata    # gate Bright Data (needs free key; see below)
npm run enrich:emails -- --agent <id> --named   # chase the person, not office@
npm run source -- --agent <id> --pages N        # size filters now actually apply
```

## The outreach system

Six modules — a Gmail client, a MIME builder, a drafter, a compliance
evaluator, a send guard, a suppression list — existed, were tested, and had
never been reached by anything. The product found leads and stopped. That gap
is now closed as far as Google's own hop.

```
leads ──▶ outreach:draft ──▶ messages (drafted) ──▶ outreach:send ──▶ Gmail
          eligibility +                             guard +            drafts
          one model call                            mailbox            or sends
```

`docs/OUTREACH.md` is the operator's guide, including the Google Cloud setup.

### What has actually run

On the `Cluj software` agent, against the live database:

```
400 leads considered
Eligible: 26

Skipped:
    360  no email address
      7  no signal to open with
      4  company in distress
      3  address never confirmed
```

Three were drafted, in Romanian, each opening with the company's own signal:

| person | company | opened with |
|---|---|---|
| Marușca Vlad Gavril | REDBEE SOFTWARE | Runs WooCommerce today |
| Finta Ionuț-Andrei | ITIZED | Mentions "ERP" on their homepage |
| Ciudin Paula | SOFT SERVICE SOLUTIONS | Mentions "ERP" on their homepage |

`outreach:send --dry-run` then walked all three through the guard, and the real
run stopped at the mailbox with instructions. **Nothing has been sent.** The
only untested hop is Google's, and it needs an OAuth client.

That skip breakdown is worth keeping: **90% of leads are skipped for having no
address at all**. The eligibility rules are not the bottleneck, and no rule
change will move this number — verification credits will.

### Decisions inside it, so they are not re-argued

- **Draft mode is the default and is not a lesser mode.** With `auto_send` off,
  each message becomes a real draft in the user's own Gmail; they read it, edit
  it, press send. That removes the research and the writing and leaves the
  judgement with the person whose name is on the message.
- **`pattern` addresses are excluded by default.** A `pattern` address is
  `first.last@domain` with nobody having checked that the mailbox exists. Bounce
  rate is the strongest single input to whether the *next* message lands in a
  spam folder, so `--allow-unverified` exists to make including them a
  deliberate act rather than a default.
- **A distress signal disqualifies rather than opens.** `scoreLead` already
  docks it, but a score is a suggestion. "I saw you've entered insolvency
  proceedings" is the worst opening line this system could produce.
- **`skipped` and `deferred` are different answers.** A suppression is
  permanent; a daily cap or a rate limit is a statement about the next few
  minutes. Collapsing them abandons a campaign the first day it hits its own
  limit.
- **The daily cap counts `messages` rows, not `email_accounts.daily_sent_count`.**
  A counter drifts when a send succeeds and the write does not; a row in state
  `sent` with a `sent_at` cannot.
- **The unsubscribe endpoint completes on POST with no confirmation.** That is
  what Gmail's native button issues (RFC 8058). A "are you sure?" page there
  unsubscribes nobody who used the button, which is most people. The link
  carries the message id — a v4 UUID — so the recipient's address never lands
  in a URL that reaches proxy logs or referrer headers.
- **Both model keys work.** `draftMessage` used to construct the Anthropic SDK
  directly, which made the one feature the product exists for dead for anyone
  without a paid Anthropic account. It now takes a `StructuredExtractor`, the
  same seam the ICP analysis uses. Claude still wins when both keys are set.
- **The send scopes are all *sensitive*, none *restricted*.** `gmail.send` +
  `gmail.compose` + `userinfo.email`. Reaching for `gmail.modify` or
  `https://mail.google.com/` would trip Google's CASA Tier 2 assessment —
  $540–1,000 plus annual recertification — for convenience this product does
  not need.

### The security-relevant part

The OAuth `state` parameter is not decoration. Without it, anyone can hand a
signed-in user a callback carrying **their own** authorisation code, and the app
would attach the attacker's mailbox to the victim's workspace — after which
every message the victim's agent sends leaves from an inbox the attacker reads.
It is an httpOnly cookie, compared in constant time, cleared after use, and the
callback checks it **before** exchanging the code. The callback also asks Google
which account it actually got rather than assuming the session's, because the
consent screen lets the user pick a different one.

`email_accounts` denies all user access by RLS. Every function in `mailbox.ts`
therefore takes the service role *and* takes `orgId` separately: with RLS
bypassed, the `.eq("org_id", …)` is the tenancy boundary.

## What was ruled out, and why

Three paid sources were evaluated in one sitting. Recording the reasoning
because each looked obviously right beforehand.

**FirmeAPI.ro (Romanian company data, ~€20/mo) — not bought.** Its headline is
97% phone coverage and 40% websites. But ANAF had been returning `telefon` and
`adresa` all along and we were discarding them for want of a column: adding two
columns took phone coverage to **70.5% for free** (98.2% of rows carry the
column; ANAF files `""` for a quarter of them), which deletes the main
reason to subscribe. Its remaining pitch is `website` at 40% — measured across
all 3M Romanian companies, where the ones *with* websites are exactly the ones
ONRC already lists. `npm run measure:firme` is built and gated on the right
population (domainless companies, not companies that already have a domain);
it needs a free key, 1,000 credits, no card. **Run it before ever paying.**

**Bright Data (LinkedIn job titles) — cannot work on the free tier.** Probed on
a real key. URL collection works and the field mapping is correct — a control
scrape returned `position`, `current_company`, `country_code` and the rest. But
**discovery is unavailable**: `type=discover_new` returns `400 Incorrect
discovery collector id. Available types:` with the list *empty*, on both live
collectors. Every other LinkedIn dataset answers `This dataset does not support
collection` — those are marketplace datasets you buy in bulk.

So it can only scrape profiles whose URLs we already hold, and we hold none.
Checked before concluding: of 40 mid-market company sites, **zero** linked a
single `linkedin.com/in/` profile, though four in five linked their
`linkedin.com/company/` page — verified against a control that fetched 500KB
pages, so this is the market and not a broken crawler. The SERP API could find
profile URLs on the same free credits but needs a zone created in the dashboard
(`/status` reports `can_make_requests: false, zone_not_found`).

**Job titles are a smaller prize than they look.** The ICP scores
`scoreTitleMatch`, and 99% of our people are titled `administrator`. But of
lead companies with a headcount figure, **66% are sole traders and only 4.8%
have 20+ employees** — and for a three-person SRL the administrator *is* the
buyer, so `administrator` is the correct title. LinkedIn data only pays where a
separate department head exists, which is why the mid-market agent was built
first. The client and matcher are kept: both correct, both tested, useful the
moment there is a source of profile URLs.

## The mid-market segment, and the bug that found it

`Mid-market pilot` (agent `eaa9561f`) targets companies with **20+ employees**
and holds **864 leads** — the segment exhausted exactly, which is the size
filter proving itself.

| | mid-market | the older leads |
|---|---|---|
| with a domain | **862 (99.8%)** | 178 (19.3%) |
| with a revenue figure | **100%** | ~16% |
| signal component | **0.257** | 0.037 |
| leads ≥50 | **251** | 90 |
| enrichment hit rate | **60%** | 12% |

Companies with real headcount almost always have a website, so every downstream
step works on them: sites to crawl, filed accounts to diff, and enough people
that a department head plausibly exists.

Building it exposed a defect worth remembering. **`scripts/run-sourcing.ts` had
its own `findCompanies` that ignored `employeeMin`, `employeeMax` and both
revenue bounds** — it applied only country, insolvency and CAEN. An agent asking
for 20+ employees got the whole register, and the run reported success either
way, because it prints *leads created*, not *leads correctly filtered*. Both
callers now share `applyIcpRangeFilters` in `src/lib/sources/anaf/adapter.ts`.

## Real people, real addresses, without LinkedIn

The goal: a lead whose contact is a named person, not `office@firma.ro`. The
reference product does it by finding the person on LinkedIn and constructing
`first.last@` at their employer's domain — every address it produced for the
user had exactly that shape.

Most of that was already built here. `people` holds **29,551 named
administrators** from ONRC's legal-representatives export — better provenance
than a LinkedIn headline, since it is a legal filing, and it cannot be
rate-limited or cut off. `src/lib/enrichment/patterns.ts` already implemented
twelve conventions including `first.last`, with Romanian diacritic folding.

So why was there not one personal address in the database? Four reasons, three
of them defects.

### The register writes surnames first. We were reading them last.

`splitFullName` takes token[0] as the given name and the last token as the
surname — right for a vendor, right for a team page, wrong for every row we
have. ONRC writes `Podar Simona Mihaela`, which is Simona Podar. The generator
produced `podar.mihaela@`: the surname as the given name, and a *second* given
name as the surname. Both halves wrong from one mistake.

Nothing caught it because generation had never run against register data, and
because the fixtures for `patterns.ts` were written given-first — the way a
developer writes their own name.

The fix does not use a downloaded name list, which would miss the Hungarian and
German names common in Transylvania (`Tussay Szilard` is surname-first too).
The register is its own dictionary: `npm run build:given-names` tallies where
each token appears across all 29,551 names. Of tokens seen 5+ times, **654
behave like given names, 1,059 like surnames, and 254 are genuinely both** —
`radu` lands in the ambiguous bucket, correctly.

`npm run backfill:names` resolved all 29,551: **89.8% on lexicon evidence**,
the rest on the source's known convention. Three rows had been keyed
given-first by whoever filed them, and the lexicon overrode the convention on
exactly those — which is the property that makes the source label safe to use.

**A name that cannot be resolved is skipped, not guessed.** One skipped name
costs a contact. One confidently wrong name puts a stranger on an email to
their employer's domain.

### The third constant zero: pattern inference

`EmailWaterfall` has always had a pattern-inference step. It has returned
`null` in production every single time, because `knownContacts` was never
supplied by any caller — and there was nothing to supply it with, since all
1,566 stored addresses were role addresses (`office@` 617, `contact@` 210).

`npm run harvest:patterns` supplies it. The mechanism needs no HTML parsing:
ONRC tells us who administers a company, so if that company publishes
`andrei.pop@firma.ro` and we hold a Pop Andrei there, the pairing confirms the
address *and* the convention at once.

**Then it was measured over 200 live Romanian sites, and the number is bad:**

| | first pass | after the crawler fixes |
|---|---|---|
| site could be read | — | **64.5%** |
| published any address | 36.5% | 35.0% |
| published a personal address | 6.5% → 3.5% | **8.6%** |
| pattern known | 0.5% → 1.5% | **2.5%** |

The middle column moved twice on purpose: 6.5% → 3.5% when `ROLE_PREFIXES` was
widened and fourteen departmental addresses stopped being counted as personal,
then 3.5% → 8.6% when `extractEmails` stopped discarding personal addresses on
any page that also carried a role one. See the landmines.

The reason is structural, not tuning. ONRC gives us the *administrator*; the
address on a contact page belongs to whoever answers the phone. They are rarely
the same person.

Two things came out of reading what it actually collected. **Fourteen of
nineteen "personal" addresses were departmental** — `administratie@`,
`comercial@`, `showroom@`, `relatiiclienti@` — because `ROLE_PREFIXES` only
covered English-centric names. That is not cosmetic misfiling: the role/personal
line is what the entire consent posture rests on.

And pairing was asking too much. `cristian.petrache@codeunit.ro` tells us the
domain writes `first.last` whether or not we hold Cristian Petrache, and the
lexicon is what makes it legible. Reading the *shape* rather than the identity
tripled coverage; across the register it settles around **2.5%**.

**That settles a design question rather than failing one.** Per-company
inference is a high-confidence bonus, not the mechanism. The prior plus
verification is the mechanism — which appears to be what the competitor does,
applying `first.last` everywhere and letting delivery sort it out.

### What it produces

Real rows from the live database, after the fix:

```
nurvil.ro     first.last  0.80  5 samples  cornel.talmaciu@nurvil.ro     (Talmaciu Cornel Ion)
trionec.ro    first.last  0.70  1 sample   vasile.nechifor@trionec.ro    (Nechifor Vasile)
selin.ro      first.last  0.60  2 samples  camelia.suarasan@selin.ro     (Suarasan Camelia)
codeunit.ro   first.last  0.55  1 sample   cristina.petrache@codeunit.ro (Petrache Cristina)
```

Surname-first read correctly throughout, diacritics folded the way an address
folds them.

### It works. Eight verified named contacts, on a real key.

`REOON_API_KEY` is set and power mode has run. The decisive test, four credits,
on one domain:

| mode | a real harvested address | an address we invented |
|---|---|---|
| **power** | `safe` | `invalid` |
| **quick** | `valid` | `valid` |

Power mode discriminates. Quick mode confirms a mailbox that does not exist,
exactly as Reoon documents — which is why `verifiesMailbox` is false for it and
guess-and-verify refuses to run on it. **Do not switch this to quick to raise
the numbers; every extra address it produced would be fictional.**

What the register now yields, from ONRC administrators plus a confirmed mailbox:

```
vlad.marusca@redbeesoftware.com   76 -> 87
cristian.banu@certplus.ro         74 -> 85
ionut.finta@itized.com            72 -> 83
paula.ciudin@softservice.ro       verified   daniel.giurea@dapredi.ro     verified
doina.toader@ttaudit.ro           verified   roxana.ene@accountable.ro    verified
ovidiu.corutiu@ccfs.ro            verified
```

**8 verified named contacts, 168 of 600 credits, best lead 87.** Cost is ~1.7
credits per lead, and the whole reachable population fits in the free tier.

45 of 924 leads carry an address: 34 role, 11 named. The ceiling is still
domains — only 178 leads have one at all.

### Verification is the load-bearing part, and it needs a key

The waterfall's rule is that a generated address is never returned as the
sendable `email` — only a vendor or a mailbox check may promote it. So without
a verifier the product generates addresses and then refuses to use any of them.

It cannot be done locally. Mailbox verification needs an SMTP `RCPT TO` probe on
port 25; Workers blocks outbound 25 and so does essentially every residential
ISP. **Vendor or nothing.**

`ReoonVerifier` implements the existing `MailboxVerifier` seam — 600/month free,
no card, catch-all detection. **`REOON_API_KEY` is not set**; the empty slot is
already in `.env.local`.

Two mapping rules carry the weight:

- **`catch_all` becomes `risky`, never `verified`.** A catch-all host accepts
  every recipient, so the probe succeeded and proved nothing. Romanian SMBs are
  overwhelmingly on shared hosting that behaves exactly this way, so getting
  this wrong would mark most of the register as confirmed.
- **A quota error becomes `unknown`, never `invalid`.** The demotion is
  persisted and would outlive the outage.

### What Romanian companies actually do — early reading

`npm run measure:patterns` reports the distribution and, past 100 domains,
recommends a reordering. Over the first 66:

```
first.last     32   48.5%
first          26   39.4%
last / first_last / lastfirst / f.last / last.first / flast   1-2 each
```

Two things follow. `first.last` leading confirms the shape the user saw from
the competitor, and it is already what `PATTERNS_BY_PREVALENCE` tries first —
which is the position that matters, since guess-and-verify stops at the first
confirmation. And **`first` at 39% is a genuine local difference**: Romanian
SMBs use a bare given name far more than the global norm, so it belongs high in
the guess order even though global folk wisdom puts it fourth.

Still below the 100-domain gate, so nothing has been reordered yet.

### Storing personal addresses is a decision that was taken

Personal addresses are persisted, not only the convention derived from them —
the user's call as data controller, so outreach has a confirmed address rather
than a generated one. It reverses the `roleOnly` posture the bulk crawler takes,
so it comes with `emails.source_url`: an address that cannot be pointed back to
the page that published it is one we should not be holding.

Romanian Law 506/2004 requires prior consent for unsolicited commercial email
with no explicit B2B carve-out; the usual basis is GDPR Art. 6(1)(f), which
recent enforcement has tightened. **A suppression list is not built, and it
blocks the first send.**

## Domains are the real ceiling, and Brave has now been measured

Only **178 of 924 leads** sit at a company with a known domain. No domain means
no address to build at all, so a perfect email engine still caps at 178 leads.

`BRAVE_SEARCH_API_KEY` is set, and `npm run discover:domains` has now run for
the first time — twice, and **the two runs disagree by two orders of
magnitude.** That disagreement is the finding.

| run | population | CUI-provable |
|---|---|---|
| `--measure --limit 60` | companies that **already have** a domain | **8.3%** (recall 28.3%) |
| `--search --leads` | the 746 lead companies that **have none** | **0.1%** — 1 of 746 |
| name guessing, earlier | companies that already have a domain | 47% recall, **0** accepted |

**The 8.3% does not transfer, and it never could have.** `--measure` works
against companies whose domain the register already carries, because that is
the only way to know the right answer in advance. But carrying a domain in the
register *is* evidence of a web presence — so the measurement population is
biased by construction toward companies that are findable. The companies we
actually need domains for are the ones with no web presence, and for them the
answer is 0.1%.

This is the same trap already recorded for keyword→company discovery: a number
measured on one population is not a number about another. It was quoted here as
if it were, for one commit.

**So domain discovery by search is dead for this purpose**, the same way name
guessing is. The 178-of-924 ceiling stands, and lifting it needs a different
inlet — a source that lists businesses *with* their websites, rather than a
search engine asked to find one. OpenStreetMap Overpass is the free candidate
worth measuring next; it is free, needs no key, and carries `website` and
`contact:email` tags for businesses that bothered to be mapped.

**Two cost landmines came out of this run**, both now fixed or recorded:

- `--dry-run` guarded only the *write*, not the searches, so
  `--search --leads --dry-run` ran 746 real queries to preview what 746 queries
  would do. It now returns before spending anything.
- The key is not on the free tier. Brave reports
  `plan: Search, usage_limit: 5.0 monthly`, and that $5 is now spent —
  `402 USAGE_LIMIT_EXCEEDED`. Further Brave work waits for the month to roll
  over, and given 0.1% there is no reason to hurry.

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

## What the wizard actually produced

Run against **smartbill.ro** with a Gemini key, in a browser, start to finish.
This is the clearest single piece of evidence that the product does what it
says, so it is written down rather than left in a terminal.

Step 1 read the real site and inferred:

> SmartBill offers cloud-based invoicing, inventory management, and fiscal
> compliance software to help Romanian businesses and accountants manage
> operations effortlessly.

| Field | What came back |
|---|---|
| Industries | E-commerce, Retail, Wholesale & distribution, Accounting/audit/legal, Business support, Financial services |
| CAEN codes | **60**, derived from those industries, not recited by the model |
| Job titles | Administrator, Director General, Contabil Șef, Director Financiar, Manager Magazin, Antreprenor |
| Keywords | program facturare, e-Factura, gestiune stocuri, soft contabilitate, SAF-T, program POS, e-Transport |
| Competitors | FGO, Oblio, SAGA, CIEL, WinMENTOR, Solo, NextUp |
| Signals | **7 chosen** |

Two things in that table are worth more than the rest.

The competitors are SmartBill's **actual** rivals in the Romanian accounting
market, named off their own site — and all seven were routed to text matching
rather than fingerprinting, because none of them ships a detectable marker.
Claiming otherwise would have been a promise that never fired.

And `enabled_signals` is set. The column has existed since the schema was laid
down and **every agent before this one shipped with it empty**; the signal
picker is the first UI ever to write it.

### The preview loop works

Five real leads came back — PROFILAXIS PUMP AND CONTROL, BARTER CONSTRUCT, LIV
PLAST, DEAVET, UNIVERSAL TOOLS DISTRIBUTION — each with its industry chip and
its repaired CAEN label, each scoring 45 (the no-email, no-signal baseline for
a company never scanned). Rejecting three produced, instantly and with no model
call:

> **Stop targeting Wholesale & distribution** — 3 of 3 rejected companies are in it.
> **Raise the minimum to 11 employees** — All 3 of 3 rejections with a headcount were smaller than that.

### Four bugs that only a real key could find

Every one of these reported itself as something other than what it was.

| Symptom | Cause |
|---|---|
| `404 Not Found` | `GEMINI_MODEL=` is `""`, not `undefined`. A default parameter only fires on `undefined`, so the URL became `.../models/:generateContent`. |
| `404`, different message | `gemini-2.5-flash` is closed to new keys. It still appears in `models.list`; the only way to find out is to call it. |
| Keyword route `502` | Gemini 3.x reasons on every request and it counts against `maxOutputTokens`. A 500 cap spent **480 tokens thinking, 5 answering**. `thinkingBudget: 0` is rejected with a 400 on this model. |
| `Could not analyse that site` | A 503 "high demand" from Google. The crawl had already succeeded. |

And one the *preview* found: applying "Stop targeting Wholesale" took the ICP
from 60 CAEN codes to **77** — more codes after removing an industry, past a
ceiling `icpSchema` enforces. `applyRefinement` was a third derivation point
that skipped the cap.

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
they cover: `verify:agents`, `verify:sourcing`, `verify:emails`, `verify:onboarding`.

Ops scripts, in the order a fresh database needs them: `import:onrc` →
`import:reps` → `enrich:registry` → `enrich:emails --companies` → `source` →
`enrich:emails` → `scan:signals` → `rescore:leads`.

`repair:caen-labels` belongs immediately after every `enrich:registry` run:
enrichment rewrites `caen` and leaves `caen_label` describing the old
activity. `verify:llm` needs nothing but a model key and answers whether
that key works.

Two development-only helpers, both reversible and neither used by app code:
`dev:session` mints a throwaway account so a browser can see real data — the
app has no demo mode once Supabase is configured — and `agent:toggle` flips
`is_active` so the free plan's single agent slot can be handed between two
agents without deleting either. Right now **`Cluj software` is deactivated**
and `SmartBill` holds the slot; the 924 leads belong to both and are
untouched by the flag.

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
| The onboarding wizard's four routes | **Verified against a live database** — `verify:onboarding`, 22 checks including the plan cap on a second preview run |
| The signal picker, industry picker and preview | **Verified in a browser** — five-step header, 37 industries with live code counts, derived codes updating on toggle |
| Gemini as the model provider | **Verified live** — `verify:llm` passes, and the wizard analysed smartbill.ro end to end |
| The five-step wizard | **Verified in a browser, against a real site** — including the preview's five real leads and the deterministic reject-to-refine chips |
| `enabled_signals` written by a UI | **Verified** — the SmartBill agent carries 7; every agent before it had an empty column |
| Claude as the model provider | **Still never run.** `ANTHROPIC_API_KEY` is present but empty in `.env.local` |
| `caen_label` repair | **Verified against the live database** — 6,369 of 17,156 rows fixed, second pass finds 0 |
| Widening the agent to derived codes | **Verified** — +758 companies, +11 contactable, **+8 leads** after re-sourcing |
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

   ~~**Phase 4** — the wizard, five steps.~~ **Done** (`b54abea`). Sources /
   Signals / Target / Preview / Outreach. The signal picker is the first UI ever
   to write `enabledSignals`; the Target step is a searchable industry picker
   with CAEN collapsed behind it; the Preview sources five real leads against a
   reused draft agent and turns rejections into deterministic suggestions.
   `npm run verify:onboarding` drives all four routes against a live database.

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

- **`agents.is_active` is a plan-cap flag, not a statement about the agent.**
  `agent:toggle` flips it to free the free plan's single slot, and both agents
  holding this workspace's 995 leads sit at `is_active = false` while their
  `status` reads `active`. `outreach:draft` filtered a *named* `--agent` on it
  and answered "No such agent" for an agent that plainly exists. Filter the
  automatic choice on it; never a named id.
- **`phone` is `""`, not NULL, for a quarter of companies.** ANAF files an empty
  string. `.not("phone", "is", null)` returns 16,850; non-empty returns 12,097.
  The first number was reported as 98.2% coverage in this document for a day.
  `not null` is not the same predicate as "has one" — check for `""` on every
  registry text column before quoting a coverage figure.
- **A `try` around a Gmail call must not also enclose the write that records
  it.** `sendOne` did, so a message Gmail had *accepted* whose database write
  then failed was marked `failed` — a candidate for a retry that sends it twice.
  Caught by a test before it shipped; the boundary is load-bearing, and there is
  a comment on it saying so.
- **A campaign starts as `draft`, and `guardSend` calls that "paused".** A first
  send therefore refused every message for a campaign nobody had ever paused.
  Checked once up front now, with `--activate` as the fix. Watch for the same
  shape elsewhere: a guard whose message describes a *transition* when the real
  state is *never started*.
- **One unreproduced test failure, recorded rather than explained away.** A full
  run reported `1 failed | 970 passed` once and has since passed **seven**
  consecutive times with no detail captured. Prime suspects are the two suites
  that spy on `globalThis.fetch` — `verifiers/reoon.test.ts` and
  `crawl/contact-harvest.test.ts` — though both restore in `afterEach`. If it
  recurs, capture the name before re-running; a flake that is never named is a
  bug that gets blamed on flakiness.
- **`npm test | grep` does not gate a `&&` chain.** grep exits 0 when it matches
  the summary line, so a red suite still lets the commit through. That is
  exactly how the failure above got committed. Same trap as the earlier
  `| tail -5 && git commit`. Gate on `npm test` alone.
- **Check what the free source already returns before buying it.** `AnafCompany`
  had parsed `phone` and `address` since the first import and `enrich-registry.ts`
  dropped both for want of a column. Adding two columns took phone coverage from
  0 to **70.5%**, free, and removed the main reason to subscribe to a vendor
  selling exactly that at five credits a company. (98.2% was the first number
  reported here and it counted `phone = ""`, which ANAF files for 4,753
  companies. `not null` is not the same predicate as "has one".) The parsed-but-discarded field
  is a recurring shape here; grep the client types before pricing a purchase.
- **A vendor's quota is the truth; `CreditLedger` is an estimate.** Reoon began
  answering `403 {"reason":"Not enough credits available"}` while the ledger
  still read 366 of a 600 limit taken from documentation — so either the free
  tier is smaller than advertised or a power-mode check costs more than one
  credit. 198 calls went out after exhaustion, each mapped to `unknown`, and the
  run reported **"0 verified"** — indistinguishable from every address being
  bad. Exhaustion now latches from the vendor's own wording (403 + "credits",
  *not* the 402 you would expect) and the guess loop stops. **Never let a local
  count be the authority on someone else's balance.**
- **A size filter also narrows to companies that filed accounts.** `gte` on a
  nullable column excludes nulls, and `employees_anaf` is null for the 75% with
  no filed accounts. `employeeMin: 20` therefore means "20+ *and* we know the
  headcount". That is correct — "we cannot tell" is not "big enough" — but it
  explains a page that comes back short.
- **Only the first three entries of `PATTERNS_BY_PREVALENCE` exist.**
  `generateCandidates` caps a blind guess at three, so anything below position
  three is never generated and the companies using it are unreachable. The list
  was global folk ordering: it spent a slot on `firstlast` (**0%** of Romanian
  domains) and put `first` at position four (**28%**). Reordering took reachable
  coverage from **59.2% to 87.4%**. Re-measure with `npm run measure:patterns`
  before touching it.
- **A report that scores "never tried" as free will recommend the worse
  option.** The first version of `measure:patterns` summed `share × position`
  over the first three only, so a convention that is never generated cost
  nothing and the *worse* order looked cheaper. Unreachable is the most
  expensive outcome there is, not the cheapest. Coverage first, cost second.
- **A failed crawl is not an answer.** `fetchContactAddresses` returned a bare
  array, so "we read the site and it publishes nothing" and "we could not read
  the site" were indistinguishable — and the harvester recorded both as
  settled. A degraded pass then reported **0.2%** of sites readable where the
  same domains sampled fresh gave 15%, and buried 3,333 of them. It now returns
  `pagesRead`, only stamps `checked` when a page was read, and warns when a run
  reads under 20% of sites. **If a pass reports a reachability far off ~64%, do
  not believe it — re-run at `--concurrency 4`.**
- **`extractEmails` treats role addresses as a preference, not a filter.** With
  no `roleOnly`, it returns role addresses *if any exist* and personal ones only
  otherwise — so a contact page carrying `office@` alongside `ion.popescu@`
  yields only `office@`. Correct for onboarding, silently fatal for the pattern
  harvester, which exists for the personal address and looks at exactly the
  pages where both appear. Pass `{ all: true }` when you want everything.
  Doubled personal-address yield when fixed, 3.5% → 8.6%.
- **Soft-404 sites eat the page budget.** Many Romanian sites return 200 with
  the homepage for every unknown path, so `/contact`, `/contacte`, `/echipa`,
  `/team` and `/despre-noi` all "succeed" with identical bytes and `/` is never
  reached. Identical bodies no longer count against the budget.
- **Record that you looked, not only that you found.** The harvester's skip
  list was keyed on `email_pattern` being set, so a resumed run re-crawled every
  domain that had already answered "nothing here" — 518 fresh crawls, zero new
  patterns. `email_pattern_checked_at` records the visit instead. This is the
  same lesson `company_scans` was created for; it had simply not been applied
  to the resume path. Any new "have we done this yet" check needs the same
  question asked of it.
- **A report that derives a label from the wrong column lies confidently.** The
  first version of `measure:patterns` split domains into "confirmed against a
  person" and "read off a shape" by testing `email_pattern_samples > 0` — true
  for both — and so reported every domain as confirmed. The basis was simply
  never stored. If a report distinguishes two kinds of evidence, something has
  to have written down which one it was.
- **A hit rate measured on companies that already have a domain says nothing
  about companies that do not.** `--measure` can only run where the right
  answer is already known, which restricts it to companies with a web presence —
  exactly the ones search finds easily. Brave scored 8.3% there and **0.1%** on
  the population that actually needs domains. Any "measured" number here must
  name its population, or it will be quoted about the wrong one.
- **A `--dry-run` that calls a metered API is not a dry run.** `discover-domains`
  guarded the write and not the searches, and one preview command spent the
  whole monthly Brave allowance. If you add a flag like this, put the guard
  before the spend, not before the insert.
- **There are two name splitters, and reaching for the familiar one is a bug.**
  `splitFullName` in `patterns.ts` reads given-name-first and is correct for
  vendors and team pages. `resolveNameParts` in `romanian-names.ts` consults
  the lexicon and is correct for the register. Anything that reads
  `people.full_name` and wants an address must use the second one with the
  source's order — `resolvePersonName` answers that in one call. Using
  `splitFullName` silently reintroduces `podar.mihaela@` for Simona Podar, and
  it will look completely normal in review.
- **`people.first_name`/`last_name` are the resolved halves, and `full_name` is
  not.** `full_name` is ONRC's display string, surname-first. Never derive an
  address from it directly; the backfill exists so nothing has to.
- **A catch-all domain is not a verified address.** Reoon returns `catch_all`
  for hosts that accept every recipient — most Romanian shared hosting. That is
  the probe succeeding and proving nothing. It maps to `risky`, and if anyone
  ever "fixes" it to `verified`, the product will confidently mark most of the
  register as reachable and burn the sending domain finding out.
- **A verifier failure must never be a verdict.** A 402 for an exhausted quota
  says nothing about the address. It maps to `unknown`; mapping it to `invalid`
  would persist a demotion that outlives the outage.
- **The role/personal split is a legal boundary, not a tidiness one.**
  `ROLE_PREFIXES` was English-centric and filed `administratie@`, `comercial@`
  and `relatiiclienti@` as personal addresses. A role address reaches a company;
  a personal one reaches an individual, and that is the distinction the consent
  posture rests on. Add Romanian departmental names as they show up.
- **Long bash heredocs mangle in this environment, reliably.** Two multi-hundred
  line `<<'EOF'` payloads died with `unexpected EOF` in this session alone. Use
  the Write and Edit tools for anything sizeable; heredocs are fine only for
  short, simple patches.
- **A blank env var is `""`, not undefined.** dotenv parses `KEY=` as an empty
  string, so a default parameter never fires and a `.optional()` never kicks in.
  `getEnv()` strips empties via `present()` for exactly this reason, but any
  code reading `process.env` directly — or any constructor taking a value from
  a caller that did — has to guard for itself. This cost an afternoon: a blank
  `GEMINI_MODEL` built `.../models/:generateContent` and returned a 404 that
  read exactly like a wrong model name.
- **Gemini's `maxOutputTokens` includes reasoning tokens.** Gemini 3.x thinks on
  every request whether the task needs it or not, ~600 tokens regardless of
  size, and `thinkingConfig: { thinkingBudget: 0 }` is a 400 on Flash. The
  adapter adds `THINKING_HEADROOM` so `ExtractInput.maxOutputTokens` keeps
  meaning "tokens of answer" for both providers. Do not lower a cap to what the
  answer alone would need.
- **A model can be listed and still be closed to you.** `gemini-2.5-flash`
  appears in `models.list` and 404s for new keys; the migration message in the
  error body is the only place the replacement is named. Pin the model, do not
  use `gemini-flash-latest` — a model that changes underneath the product
  silently changes every ICP it produces.
- **There is exactly one place codes are derived, and it is
  `normaliseIcpIndustries`.** `applyRefinement` grew a second one and produced a
  list *past* the 60-code ceiling when dropping an industry from an
  already-truncated ICP. If you find yourself calling `naceCodesFor` outside
  that function, you are building the third.
- **A component must not hard-require a provider its own module exports.**
  `ContactsTable` threw and took the agent's Leads tab down, because that page
  renders it without the toolbar it shares selection with. `WithContactEnrichment`
  supplies the context only when no ancestor has. The same shape will bite any
  other context added for a two-sibling screen.

- **A long ops script must write as it goes.** The ANAF financials pass
  buffered every update and wrote once at the end; interrupted at 4,825 of
  5,401 it wrote **nothing** — three hours of requests gone, and nothing for
  `--missing-financials` to resume from. It now flushes every 50 companies.
  Any script that runs for hours needs the same treatment, and the resume flag
  has to key on a column the flush actually sets.
- **A column named after a thing must show that thing.** The Contacts SIGNAL
  column read `source_label`/`source_query` — the CAEN code a lead was *found*
  by — for several releases, while the real signals sat one click down in the
  score breakdown. Nobody noticed because it rendered something plausible. When
  a surface and a feature share a name, check that they share a data source.
- **The app has no demo mode once Supabase is configured**, so looking at real
  data in a browser needs a session. `npm run dev:session` mints a throwaway
  account and prints the cookie; `--cleanup` removes them. Sessions last an
  hour — a bounce to `/login` means run it again, not that something broke.

- **Deselecting an industry has to clear the free text too.** `industries` and
  `industryKeys` are two representations of one thing, and
  `normaliseIcpIndustries` resolves the first into the second — that is the
  mechanism, not a bug. But it means removing only the key leaves the phrase
  behind and the next pass puts the industry straight back. Both callers that
  remove a key (`IndustryPicker.toggle`, `applyRefinement`) drop the matching
  phrase by **resolving** it, not by comparing to the label. Found by clicking a
  checkbox that did nothing, not by a test.
- **`/onboarding?seed=demo` is development-only** and gated on `NODE_ENV`. It
  exists because step 1 needs `ANTHROPIC_API_KEY` — which is present but *empty*
  in `.env.local`, so the ICP analysis has still never run — while steps 2 to 5
  do not. Without it the new screens are unreachable without spending a Claude
  call.

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
- ~~**The ANAF financials pass was never run.**~~ **Half done.** **2,428 of
  5,406** companies with a website now carry both filing years, against 5
  before; **2,894 remain**, roughly 1.8 hours. Resume with the same command —
  `--missing-financials` skips what is done. Then `scan:signals` and
  `rescore:leads`, or the filings sit in the table without ever becoming
  `anaf_growth` signals.
  *Original note* (`1928fc0`):
  `npm run enrich:registry -- --has-website --missing-financials` covers the
  5,401 companies a web scan will ever look at. It is 2 requests per company
  (both years, because growth needs a pair) at ANAF's ~1.1s, so roughly 3.3
  hours — and resumable, which is what `--missing-financials` is for.
  Re-run `scan:signals` and `rescore:leads` afterwards to turn the filings
  into `anaf_growth` signals. **Then re-run `repair:caen-labels`**, because
  enrichment rewrites `caen` and leaves the label stale again.
  *Original note:* **The ANAF financials pass was never run.** Only **29 of 17,156** companies
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
- ~~**`caen_label` is wrong for a large share of rows.**~~ **Repaired**
  (`fd1cfc9`): **6,369 of 17,156 rows — 37% — described the wrong activity**,
  almost always "custom software development", because the first import
  filtered on division 62 and set the label from ONRC's *authorised* activity
  before enrichment replaced `caen` with what ANAF says the company files
  under. `npm run repair:caen-labels -- --file n_caen.csv` fixes it and is
  idempotent. **Re-run it after every `enrich:registry` pass** — the two scripts
  still disagree, and this repairs the result rather than the cause.
  The rest of that landmine stands: **CAEN revisions are
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
