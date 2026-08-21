import type { PeopleProvider } from "@/lib/sources/people/types";
import { CreditLedger } from "./ledger";
import { MxChecker, type MailboxVerifier } from "./mx";
import {
  generateCandidates,
  inferDominantPattern,
  isPlausibleEmail,
  isRoleAddress,
  splitFullName,
  type EmailCandidate,
  type EmailPattern,
} from "./patterns";

/**
 * The email waterfall.
 *
 * Steps run cheapest-first and stop at the first result good enough for the
 * caller's threshold, so a paid vendor is only ever reached for the contacts
 * the free steps could not resolve:
 *
 *   1. role addresses already found by the crawler      — free
 *   2. pattern inference from confirmed addresses       — free
 *   3. MX check, to discard domains that take no mail   — free
 *   4. vendor free tiers, budget permitting             — metered
 *
 * Two invariants hold throughout. Every attempt is recorded, including
 * failures, so a dead lookup is never paid for twice. And a pattern-generated
 * address is never labelled `verified` — only a vendor or a mailbox verifier
 * can promote it, because sending to a guess is how a domain's reputation
 * gets burned.
 */

/**
 * Mirrors the `emails.status` check constraint in `src/lib/db/schema.ts`.
 *
 * `bounced` is never produced by the waterfall — it is written by the send
 * path after a real delivery failure. It belongs here anyway, because this type
 * is also what reads a persisted row back, and a status the database can hold
 * but the type cannot is a narrowing failure waiting for the first bounce.
 */
export type EmailStatus =
  | "pattern"
  | "found"
  | "verified"
  | "risky"
  | "invalid"
  | "bounced";

export type ResolvedEmail = {
  address: string;
  status: EmailStatus;
  confidence: number;
  /** Which waterfall step produced it. */
  provider: string;
  isRoleAddress: boolean;
  pattern?: EmailPattern;
  mxValid?: boolean;
};

export type WaterfallAttempt = {
  provider: string;
  outcome: "hit" | "miss" | "skipped" | "error";
  detail?: string;
  creditsSpent: number;
};

export type WaterfallResult = {
  email: ResolvedEmail | null;
  /** Everything tried, in order — the audit trail the UI shows. */
  attempts: WaterfallAttempt[];
  /** Alternatives worth keeping for a retry after a bounce. */
  alternatives: ResolvedEmail[];
};

export type WaterfallInput = {
  fullName: string;
  domain: string;
  companyName?: string;
  /** Role addresses the crawler already found at this domain. */
  knownRoleEmails?: string[];
  /** Confirmed name/address pairs at this domain, for pattern inference. */
  knownContacts?: { email: string; fullName: string }[];
  /**
   * The convention already known for this domain, from a previous harvest.
   *
   * Preferred over `knownContacts` when both are present: the stored pattern
   * was inferred once from every address the domain published, while
   * `knownContacts` is whatever this caller happened to have. Re-deriving it
   * per lead would also mean every lead at a company re-doing the same work.
   */
  knownPattern?: { pattern: EmailPattern; confidence: number };
  /**
   * The person's name halves, already resolved.
   *
   * Must be supplied for anyone out of the register: `splitFullName` reads
   * given-name-first and ONRC writes surname-first, so letting the display name
   * be re-split here produces `podar.mihaela@` for Simona Podar.
   */
  nameParts?: { firstName?: string; lastName?: string };
  /** Stop once a result at or above this confidence is found. */
  targetConfidence?: number;
};

export type WaterfallDeps = {
  ledger: CreditLedger;
  mx?: MxChecker;
  /** Vendor providers, in the order they should be tried. */
  providers?: PeopleProvider[];
  verifier?: MailboxVerifier;
};

const DEFAULT_TARGET_CONFIDENCE = 0.75;

export class EmailWaterfall {
  constructor(private readonly deps: WaterfallDeps) {}

  async resolve(input: WaterfallInput): Promise<WaterfallResult> {
    const target = input.targetConfidence ?? DEFAULT_TARGET_CONFIDENCE;
    const attempts: WaterfallAttempt[] = [];

    // Candidates are collected rather than folded into a running best, so the
    // winner is chosen once by confidence and every runner-up survives as a
    // retry option after a bounce.
    const candidates: ResolvedEmail[] = [];
    const consider = (candidate: ResolvedEmail) => candidates.push(candidate);

    // --- 3 (run first): does this domain accept mail at all? ---------------
    // Ordered ahead of the lookups despite being step 3 conceptually: a domain
    // with no MX makes every later step pointless, and skipping them saves
    // credits rather than spending them to learn the same thing.
    let mxValid: boolean | undefined;
    if (this.deps.mx) {
      const mx = await this.deps.mx.check(input.domain);
      if (mx.error) {
        attempts.push({
          provider: "mx",
          outcome: "error",
          detail: mx.error,
          creditsSpent: 0,
        });
      } else {
        mxValid = mx.acceptsMail;
        attempts.push({
          provider: "mx",
          outcome: mx.acceptsMail ? "hit" : "miss",
          detail: mx.acceptsMail
            ? `${mx.hosts.length} MX record(s)${mx.provider ? `, ${mx.provider}` : ""}`
            : "domain accepts no mail",
          creditsSpent: 0,
        });

        if (!mx.acceptsMail) {
          return { email: null, attempts, alternatives: [] };
        }
      }
    }

    // --- 1. Role addresses the crawler already has -------------------------
    const roleEmails = (input.knownRoleEmails ?? []).filter(isPlausibleEmail);
    if (roleEmails.length > 0) {
      // Kept as an alternative, not returned outright: a role address reaches
      // the company, not the person. It is the fallback the RO compliance
      // path prefers, so it must survive to the end of the chain.
      for (const address of roleEmails) {
        consider({
          address,
          status: "found",
          confidence: 0.55,
          provider: "crawler",
          isRoleAddress: true,
          mxValid,
        });
      }
      attempts.push({
        provider: "crawler",
        outcome: "hit",
        detail: `${roleEmails.length} role address(es)`,
        creditsSpent: 0,
      });
    }

    // --- 2. Pattern inference from confirmed contacts ----------------------
    const inferred = input.knownPattern ?? this.inferPattern(input);
    if (inferred) {
      const [candidate] = generateCandidates(input.fullName, input.domain, {
        knownPattern: inferred.pattern,
        patternConfidence: inferred.confidence,
        parts: input.nameParts,
        max: 1,
      });

      if (candidate) {
        consider({
          address: candidate.address,
          // Still "pattern": inferring a convention is strong evidence, but it
          // is not confirmation that this mailbox exists.
          status: "pattern",
          confidence: inferred.confidence,
          provider: "pattern",
          isRoleAddress: false,
          pattern: candidate.pattern,
          mxValid,
        });
        attempts.push({
          provider: "pattern",
          outcome: "hit",
          detail: `${inferred.pattern} at ${(inferred.confidence * 100).toFixed(0)}% from ${input.knownContacts?.length ?? 0} sample(s)`,
          creditsSpent: 0,
        });
      }
    } else {
      attempts.push({
        provider: "pattern",
        outcome: "miss",
        detail: "no confirmed address at this domain to infer a convention from",
        creditsSpent: 0,
      });
    }

    const earlyBest = bestOf(candidates);
    if (earlyBest && earlyBest.confidence >= target) {
      return { email: earlyBest, attempts, alternatives: dedupe(candidates, earlyBest) };
    }

    // --- 4. Vendor free tiers ----------------------------------------------
    for (const provider of this.deps.providers ?? []) {
      if (!provider.isConfigured()) {
        attempts.push({
          provider: provider.key,
          outcome: "skipped",
          detail: "not configured",
          creditsSpent: 0,
        });
        continue;
      }

      if (!(await this.deps.ledger.hasBudget(provider.key))) {
        attempts.push({
          provider: provider.key,
          outcome: "skipped",
          detail: "monthly free-tier allowance exhausted",
          creditsSpent: 0,
        });
        continue;
      }

      try {
        const people = await provider.findPeople({
          domain: input.domain,
          companyName: input.companyName,
          limit: 25,
        });
        await this.deps.ledger.spend(provider.key);

        const match = matchPerson(people, input.fullName);
        if (match?.email && isPlausibleEmail(match.email)) {
          consider({
            address: match.email,
            // A vendor returning a specific person's address is the strongest
            // signal short of an actual mailbox check.
            status: "verified",
            confidence: match.emailConfidence ?? 0.85,
            provider: provider.key,
            isRoleAddress: isRoleAddress(match.email),
            mxValid,
          });
          attempts.push({
            provider: provider.key,
            outcome: "hit",
            detail: `matched ${match.fullName}`,
            creditsSpent: 1,
          });

          const top = bestOf(candidates);
          if (top && top.confidence >= target) break;
        } else {
          attempts.push({
            provider: provider.key,
            outcome: "miss",
            detail: people.length
              ? `${people.length} people returned, none matching ${input.fullName}`
              : "no people returned",
            creditsSpent: 1,
          });
        }
      } catch (error) {
        // A provider failure must not sink the chain — the next one may hit.
        attempts.push({
          provider: provider.key,
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
          creditsSpent: 0,
        });
      }
    }

    // --- Optional mailbox verification -------------------------------------
    let best = bestOf(candidates);
    /*
     * Verify everything except what we saw published.
     *
     * A crawled address was read off the company's own contact page: the
     * company put it there for people to write to, which is the strongest
     * evidence available short of delivery, and spending a credit to re-learn
     * it is a lead we cannot reach later on a 600-a-month free tier.
     *
     * Everything else is worth the credit. A generated address is a guess whose
     * entire standing depends on this check, and a vendor's answer is a claim
     * by a third party that we have not independently confirmed — its `verified`
     * status reflects the vendor's confidence, not ours.
     */
    if (best && best.provider !== "crawler" && this.deps.verifier) {
      const candidate = best;
      try {
        const verdict = await this.deps.verifier.verify(candidate.address);
        attempts.push({
          provider: this.deps.verifier.key,
          outcome: verdict.status === "invalid" ? "miss" : "hit",
          detail: verdict.reason ?? verdict.status,
          creditsSpent: 1,
        });

        if (verdict.status === "invalid") {
          // Demote rather than delete: the address may still be worth a
          // human's judgement, but nothing should auto-send to it.
          best = { ...candidate, status: "invalid", confidence: 0.05 };
        } else if (verdict.status === "verified") {
          best = {
            ...candidate,
            status: "verified",
            confidence: Math.max(candidate.confidence, 0.95),
          };
        } else if (verdict.status === "risky") {
          best = { ...candidate, status: "risky", confidence: Math.min(candidate.confidence, 0.5) };
        }
      } catch (error) {
        attempts.push({
          provider: this.deps.verifier.key,
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
          creditsSpent: 0,
        });
      }
    }

    // --- Last resort: guess the convention, and let the mailbox settle it ----
    /*
     * The step that makes a domain with no learned convention reachable.
     *
     * Most Romanian SMBs publish `office@` and nothing else, so per-company
     * inference fires on about 2.5% of domains (measured — see docs/STATUS.md).
     * For the rest there is no evidence to read, only the prevalence order in
     * `PATTERNS_BY_PREVALENCE`, which leads with `first.last`.
     *
     * A guess is not an answer. But a guess a mailbox *confirms* is, and that
     * is what the competitor appears to do: apply `first.last` everywhere and
     * let delivery sort it out. Verifying is the difference between doing that
     * responsibly and spraying.
     *
     * Without a verifier these stay `alternatives` and never become `email` —
     * unchanged behaviour, and the reason the product degrades safely when no
     * key is set.
     */
    /*
     * Runs when we have nothing *or* only a company mailbox.
     *
     * `!best` alone was wrong, and it silently disabled this whole step for the
     * majority of leads: a crawled `office@` is a perfectly good `best`, so any
     * company publishing one never got a named-contact attempt at all. That is
     * exactly backwards — reaching the company is the fallback, and reaching the
     * person is the product.
     *
     * The caller decides via `targetConfidence`. Left at the default, a role
     * address satisfies it and nothing here runs, so the free path stays free.
     * Raised above the role threshold, the chain keeps going and spends
     * verification credits looking for the person.
     */
    const roleOnlySoFar = Boolean(best?.isRoleAddress && best.confidence < target);

    if (!best || roleOnlySoFar) {
      const guesses = generateCandidates(input.fullName, input.domain, {
        parts: input.nameParts,
        max: 3,
      });

      if (this.deps.verifier && guesses.length > 0) {
        const promoted = await this.verifyGuesses(guesses, attempts, mxValid);
        if (promoted) {
          // A confirmed personal address beats a role address outright, and the
          // role one survives in `alternatives` as the fallback it always was.
          return {
            email: promoted,
            attempts,
            alternatives: dedupe(candidates, promoted),
          };
        }
      }

      for (const guess of guesses) {
        candidates.push({
          address: guess.address,
          status: "pattern",
          confidence: guess.confidence,
          provider: "pattern-guess",
          isRoleAddress: false,
          pattern: guess.pattern,
          mxValid,
        });
      }
      attempts.push({
        provider: "pattern-guess",
        outcome: guesses.length ? "hit" : "miss",
        detail: guesses.length
          ? `${guesses.length} unverified guess(es) — not safe to auto-send`
          : "could not build a candidate from this name",
        creditsSpent: 0,
      });

      // No confirmed person, but the role address is still a real way to reach
      // the company — returning null here would discard it.
      if (best) return { email: best, attempts, alternatives: dedupe(candidates, best) };
      return { email: null, attempts, alternatives: dedupe(candidates, null) };
    }

    return { email: best, attempts, alternatives: dedupe(candidates, best) };
  }

  /**
   * Try the likeliest conventions against the mailbox, best first.
   *
   * Returns the first one the verifier confirms, or null when none is
   * confirmed — in which case the caller keeps them as unsendable alternatives.
   *
   * Two economies matter here, because the free tier is 600 checks a month and
   * this is the step that would otherwise eat it:
   *
   * **Catch-all stops the loop.** If the first address comes back `catch_all`,
   * the host accepts every recipient and the second and third guesses would
   * return exactly the same non-answer. Trying them spends two more credits to
   * learn nothing, so the loop stops and the domain is recorded as
   * unconfirmable.
   *
   * **`invalid` is progress, `unknown` is not.** A rejected recipient means the
   * next convention is worth trying. An `unknown` means the check itself failed
   * — the quota, the network, the vendor — and hammering it with two more
   * addresses turns one failure into three.
   */
  private async verifyGuesses(
    guesses: readonly EmailCandidate[],
    attempts: WaterfallAttempt[],
    mxValid: boolean | undefined,
  ): Promise<ResolvedEmail | null> {
    const verifier = this.deps.verifier;
    if (!verifier) return null;

    /*
     * A verifier that does not probe the mailbox cannot settle a guess.
     *
     * It would answer "yes" for every address at any live domain — including
     * the ones we invented a moment ago — so running it here would confirm
     * every guess, spend a credit doing it, and hand the send path an address
     * nobody has established exists. That is strictly worse than returning
     * nothing, because nothing is honest.
     *
     * Returning early rather than spending and discarding: the budget is 600 a
     * month and this path would burn it learning what `MxChecker` already
     * establishes for free.
     */
    if (!verifier.verifiesMailbox) {
      attempts.push({
        provider: verifier.key,
        outcome: "skipped",
        detail:
          "cannot confirm a generated address — this verifier checks the domain, " +
          "not the mailbox. Switch it to a mode that probes the inbox.",
        creditsSpent: 0,
      });
      return null;
    }

    for (const guess of guesses) {
      if (!(await this.deps.ledger.hasBudget(verifier.key))) {
        attempts.push({
          provider: verifier.key,
          outcome: "skipped",
          detail: "monthly verification allowance exhausted",
          creditsSpent: 0,
        });
        return null;
      }

      let verdict;
      try {
        verdict = await verifier.verify(guess.address);
      } catch (error) {
        attempts.push({
          provider: verifier.key,
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
          creditsSpent: 0,
        });
        return null;
      }
      await this.deps.ledger.spend(verifier.key);

      attempts.push({
        provider: verifier.key,
        outcome: verdict.status === "verified" ? "hit" : "miss",
        detail: `${guess.pattern}: ${verdict.reason ?? verdict.status}`,
        creditsSpent: 1,
      });

      if (verdict.status === "verified") {
        return {
          address: guess.address,
          status: "verified",
          // A confirmed mailbox is a confirmed mailbox however it was arrived
          // at — the guess is no longer load-bearing once the check passed.
          confidence: 0.95,
          provider: "pattern-verified",
          isRoleAddress: false,
          pattern: guess.pattern,
          mxValid,
        };
      }

      if (verdict.isCatchAll || verdict.status === "risky") return null;
      if (verdict.status === "unknown") return null;
    }

    return null;
  }

  private inferPattern(
    input: WaterfallInput,
  ): { pattern: EmailPattern; confidence: number } | null {
    const contacts = input.knownContacts ?? [];
    if (contacts.length === 0) return null;

    return inferDominantPattern(
      contacts.map((c) => ({ email: c.email, name: splitFullName(c.fullName) })),
    );
  }
}

/**
 * Finds the person in a provider's result set.
 *
 * Compares on slugified first+last so "Ana-Maria Popescu" matches
 * "Ana Maria Popescu", and diacritics don't cause a miss.
 */
function matchPerson<T extends { fullName: string; email?: string; emailConfidence?: number }>(
  people: T[],
  target: string,
): T | undefined {
  const key = nameKey(target);
  if (!key) return undefined;
  return people.find((p) => nameKey(p.fullName) === key);
}

function nameKey(fullName: string): string {
  const { firstName, lastName } = splitFullName(fullName);
  const normalise = (v?: string) =>
    (v ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[șş]/gi, "s")
      .replace(/[țţ]/gi, "t")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
  return `${normalise(firstName)}|${normalise(lastName)}`;
}

/** Highest-confidence candidate, or null when there are none. */
function bestOf(candidates: ResolvedEmail[]): ResolvedEmail | null {
  return candidates.reduce<ResolvedEmail | null>(
    (top, c) => (!top || c.confidence > top.confidence ? c : top),
    null,
  );
}

/** Everything except the winner, deduped by address, best first. */
function dedupe(
  candidates: ResolvedEmail[],
  best: ResolvedEmail | null,
): ResolvedEmail[] {
  const seen = new Set(best ? [best.address] : []);
  const out: ResolvedEmail[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.confidence - a.confidence)) {
    if (seen.has(candidate.address)) continue;
    seen.add(candidate.address);
    out.push(candidate);
  }
  return out;
}
