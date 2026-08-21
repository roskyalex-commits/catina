# Outreach

How a lead becomes an email, and what has to be true before one can leave.

## The shape of it

```
leads ──▶ outreach:draft ──▶ messages (drafted) ──▶ outreach:send ──▶ Gmail
          eligibility +                             guard +            drafts
          one model call                            mailbox            or sends
```

Two commands, deliberately. Drafting costs a model call per lead and sending
costs the org's reputation, and those want different failure behaviour: a bad
draft is discarded, a bad send cannot be.

```bash
npm run outreach:draft -- --agent <id> --dry-run
```

Start here every time. It makes no model calls, writes nothing, and prints the
number that actually matters — the breakdown of *why* leads were skipped.

## What is verified and what is not

| | |
|---|---|
| Eligibility, drafting, scheduling, the queue screen | **run against real data** |
| The send guard, suppression re-check, daily cap | **unit-tested**, exercised in `--dry-run` |
| Anything past `GmailClient` | **never executed** — no OAuth client exists yet |

Nothing has ever been sent from this system. The last unproven hop is Google's,
and closing it is the section below.

The first real run, on 400 leads of the `Cluj software` agent:

```
Eligible: 26

Skipped:
    360  no email address
      7  no signal to open with
      4  company in distress
      3  address never confirmed
```

That breakdown is the product's whole state in four lines. The eligibility
rules are not the bottleneck — 90% of leads have no address at all.

## Connecting Gmail

This is the only step that cannot be automated: it needs a Google Cloud project
and a human at a consent screen.

**1. Create an OAuth client.**
[console.cloud.google.com](https://console.cloud.google.com/) → APIs & Services
→ Credentials → Create credentials → **OAuth client ID** → *Web application*.

**2. Add the redirect URI**, byte for byte:

```
http://localhost:3000/api/v1/auth/google/callback
```

A URI that differs by one character fails with `redirect_uri_mismatch`, and
Google does not say which end is wrong. `googleRedirectUri()` in
`src/app/api/v1/auth/google/state.ts` builds the app's half from
`NEXT_PUBLIC_APP_URL`; a trailing slash there is the usual cause.

**3. Enable the Gmail API** — APIs & Services → Library → Gmail API → Enable.

**4. On the OAuth consent screen**, add these three scopes:

| scope | why |
|---|---|
| `gmail.send` | send on the user's behalf |
| `gmail.compose` | create drafts — the default posture |
| `userinfo.email` | know which mailbox was connected |

All three are **sensitive**, none is **restricted**. That distinction is worth
protecting: sensitive scopes need Google's ~10-day verification, restricted
scopes additionally need a CASA Tier 2 security assessment at $540–1,000 plus
annual recertification. Reaching for `gmail.modify` or `https://mail.google.com/`
for convenience crosses that line and adds a recurring audit obligation to a
product that does not need one.

While unverified, Google caps the app at **100 test users**. Add your own
address under Test users or the consent screen will refuse you.

**5. Put the credentials in `.env.local`:**

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

Restart the dev server, open `/app/settings`, press **Connect Gmail**.

## Sending

```bash
npm run outreach:send -- --agent <id> --dry-run      # verdicts, no Gmail call
npm run outreach:send -- --agent <id> --activate     # start the campaign, once
npm run outreach:send -- --agent <id>                # create the Gmail drafts
```

**Draft mode is the default and it is not a lesser mode.** With `auto_send` off,
each message becomes a real draft in your own Gmail. You open Gmail, read it,
edit anything that reads like a machine wrote it, and press send. That removes
the research and the writing and leaves the judgement with the person whose
name is on the message — which is the right split for cold outreach.

A campaign starts as `draft` and will not send until `--activate`. That is
separate from auto-send, and both are separate again from the queue screen's
**Send now**, which sends one message the user is looking at.

### What stops a send

Everything below runs on **every** message, from the CLI and the queue screen
alike — `sendOne` is the single path.

- **The suppression list**, re-read per message rather than per run. The queue
  was built hours ago and an unsubscribe can land in between.
- **The daily cap**, 30, counted from `messages` rows rather than a counter
  column so it cannot drift. The number is about deliverability, not about
  Gmail's limit, which is roughly fifteen times higher.
- **Duplicate protection** — one message per lead per campaign.
- **A valid address**, checked for header-injection newlines as well as shape.
- **The compliance verdict** blocks only one case: auto-send into a
  consent-required market with no acknowledgement recorded. A human pressing
  send has made that decision themselves; an unattended queue has not.

`skipped` and `deferred` are different answers and are kept apart. A daily cap
or a rate limit is temporary, and marking those `skipped` would abandon a
campaign the first day it hit its own limit.

## Unsubscribe

Every message carries the link in the body and twice in the headers
(`List-Unsubscribe`, `List-Unsubscribe-Post`), which is what gives Gmail and
Outlook their native unsubscribe button.

That button issues a **POST with no confirmation step** (RFC 8058), so
`/api/v1/unsubscribe` completes the opt-out on POST immediately. A "are you
sure?" page there would silently unsubscribe nobody who used the button, which
is most people.

The link carries the message id and nothing else — a v4 UUID, 122 bits, not
enumerable — so the recipient's address never appears in a URL that ends up in
proxy logs or referrer headers. Anyone holding the link can opt that recipient
out, which is deliberate: forwarding the mail to a colleague so they can remove
the company is a legitimate thing to want.

## Romania is the strict market

Law 506/2004 has no B2B exemption, and ANSPDCP fines run RON 5,000–100,000 or up
to 2% of turnover. The product warns clearly, records an acknowledgement, and
leaves the send decision with the user — the one hard block is the
do-not-contact list, because honouring an opt-out is not a judgement call.

Every message includes a GDPR Article 14 notice naming where the details came
from, because the recipient did not provide them:

> your company's details are on the Romanian trade register (ONRC) and the tax
> register (ANAF)

Naming the actual registers rather than "public sources" is the difference
between a disclosure and a hand-wave.

This is a summary, not legal advice.

## Files

| | |
|---|---|
| `src/lib/outreach/pipeline.ts` | who gets written to, and why not |
| `src/lib/outreach/draft.ts` | the model call; either Anthropic or Gemini |
| `src/lib/outreach/send.ts` | the last gate, and the only path to Gmail |
| `src/lib/outreach/send-guard.ts` | the rules `send.ts` enforces |
| `src/lib/outreach/mailbox.ts` | tokens at rest, and access tokens on demand |
| `src/lib/outreach/suppressions.ts` | the do-not-contact list |
| `src/lib/outreach/compliance.ts` | per-country posture and required disclosures |
| `src/app/api/v1/auth/google/` | the OAuth dance |
| `src/app/api/v1/outreach/queue/` | approve / skip / send now |
| `src/app/api/v1/unsubscribe/` | the opt-out |
