/**
 * Sends what `outreach:draft` wrote.
 *
 *   npm run outreach:send -- --dry-run           # what would leave, and to whom
 *   npm run outreach:send                        # Gmail drafts, in the user's mailbox
 *   npm run outreach:send -- --now               # ignore the schedule
 *
 * This is the only script in the repo that produces something a stranger sees,
 * so it is built to be run in the wrong mood without doing damage:
 *
 *   - **Draft mode is the default.** Unless the campaign has `auto_send` on,
 *     every message becomes a draft in the connected Gmail account. Nothing
 *     leaves until a person presses send in Gmail.
 *   - **--dry-run talks to nothing.** No Gmail call, no writes. It prints the
 *     recipient, the subject and the guard's verdict for each message.
 *   - **The daily cap is real.** Read from `messages`, not from a counter, so
 *     it cannot drift. `CONSERVATIVE_DAILY_LIMIT` is 30 and the reason is
 *     deliverability, not Gmail's limit, which is fifteen times higher.
 *
 * ## Before the first run
 *
 * A mailbox has to be connected, which is a browser flow — `/app/settings`,
 * "Connect Gmail". See `docs/OUTREACH.md` for the Google Cloud side.
 */
import { createClient } from "@supabase/supabase-js";
import { GmailClient, CONSERVATIVE_DAILY_LIMIT } from "../src/lib/outreach/gmail";
import {
  MailboxError,
  accessTokenFor,
  findMailbox,
  recordSend,
  sentToday,
} from "../src/lib/outreach/mailbox";
import {
  DUE_MESSAGE_COLUMNS,
  dueMessageFrom,
  sendOne,
  type SendContext,
  type SendOutcome,
} from "../src/lib/outreach/send";
import { requireEnv } from "./load-env";

const DEFAULT_LIMIT = 30;

type Options = {
  agentId?: string;
  limit: number;
  dryRun: boolean;
  /** Send everything due or not — for testing, and it says so in the output. */
  now: boolean;
  mailbox?: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: DEFAULT_LIMIT, dryRun: false, now: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--agent":
        options.agentId = next();
        break;
      case "--mailbox":
        options.mailbox = next();
        break;
      case "--limit":
        options.limit = Number(next());
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--now":
        options.now = true;
        break;
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return options;
}

const db = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const campaign = await loadCampaign(options.agentId);
  if (!campaign) process.exit(1);

  const mailbox = await findMailbox(db, campaign.orgId, options.mailbox ?? campaign.senderEmail);
  if (!mailbox && !options.dryRun) {
    console.error(
      "No Gmail account is connected.\n\n" +
        "  Start the app, open /app/settings and press Connect Gmail. That needs\n" +
        "  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set — see docs/OUTREACH.md.\n\n" +
        "  Until then, --dry-run shows what would go out.",
    );
    process.exit(1);
  }

  const already = await sentToday(db, campaign.orgId);
  const limit = Math.min(campaign.dailyLimit, CONSERVATIVE_DAILY_LIMIT);

  console.log(`Campaign: ${campaign.name}`);
  console.log(`Mailbox:  ${mailbox?.address ?? "(none — dry run)"}`);
  console.log(
    `Mode:     ${campaign.autoSend ? "AUTO-SEND — messages leave immediately" : "draft into Gmail (nothing leaves on its own)"}`,
  );
  console.log(`Today:    ${already} sent, cap ${limit}`);
  if (options.now) console.log(`Schedule: ignored (--now)`);

  const messages = await loadDue(campaign, options);
  console.log(`\n${messages.length} message${messages.length === 1 ? "" : "s"} due\n`);
  if (messages.length === 0) return;

  let gmail: GmailClient | null = null;
  if (!options.dryRun && mailbox) {
    try {
      const token = await accessTokenFor(db, mailbox, {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        encryptionKey: requireEnv("ENCRYPTION_KEY"),
      });
      gmail = new GmailClient(token);
    } catch (error) {
      console.error(
        `\n${error instanceof MailboxError ? error.message : String(error)}` +
          (error instanceof MailboxError && error.needsReauth
            ? "\n\n  Open /app/settings and connect the mailbox again."
            : ""),
      );
      process.exit(1);
    }
  }

  const context: SendContext = {
    admin: db,
    orgId: campaign.orgId,
    gmail,
    sender: {
      email: mailbox?.address ?? "dry-run@localhost",
      senderName: campaign.senderName,
      senderCompany: campaign.senderCompany ?? undefined,
      // GDPR Art. 14: the recipient did not give us their details, so the
      // message has to say where they came from. Naming the actual register
      // rather than "public sources" is the difference between a disclosure
      // and a hand-wave.
      dataSource:
        "your company's details are on the Romanian trade register (ONRC) and " +
        "the tax register (ANAF)",
    },
    campaign: {
      id: campaign.id,
      autoSend: campaign.autoSend,
      active: campaign.status === "active",
      dailyLimit: limit,
      complianceAcknowledged: campaign.complianceAcknowledged,
    },
    sentToday: already,
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    dryRun: options.dryRun,
  };

  const outcomes: SendOutcome[] = [];

  for (const message of messages) {
    const outcome = await sendOne(context, message);
    outcomes.push(outcome);
    report(outcome);

    if (outcome.state === "sent") {
      // The cap is enforced against a live counter, not the value read once at
      // the top: a run of 30 must stop at 30, not send 30 more than it started.
      context.sentToday += 1;
      if (mailbox) await recordSend(db, mailbox);
    }

    /*
     * A deferral from the daily cap or a Gmail rate limit applies to every
     * message behind it too. Continuing would produce one identical failure per
     * remaining row and bury the one line that matters.
     */
    if (outcome.state === "deferred" && outcome.code === "daily_limit") {
      console.log(`\n  Stopping: ${outcome.reason}`);
      break;
    }
  }

  summarise(outcomes, options);
}

function report(outcome: SendOutcome): void {
  const to = `${outcome.message.recipientName.slice(0, 22).padEnd(24)} ${outcome.message.recipientEmail.slice(0, 34).padEnd(36)}`;
  switch (outcome.state) {
    case "sent":
      console.log(`  sent      ${to} ${outcome.message.subject.slice(0, 40)}`);
      break;
    case "in_gmail_drafts":
      console.log(`  drafted   ${to} ${outcome.message.subject.slice(0, 40)}`);
      break;
    case "would_send":
      console.log(`  would     ${to} ${outcome.message.subject.slice(0, 40)}`);
      break;
    case "skipped":
      console.log(`  skipped   ${to} ${outcome.reason}`);
      break;
    case "deferred":
      console.log(`  deferred  ${to} ${outcome.reason}`);
      break;
    case "failed":
      console.log(`  FAILED    ${to} ${outcome.reason}`);
      break;
  }
}

function summarise(outcomes: readonly SendOutcome[], options: Options): void {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    counts.set(outcome.state, (counts.get(outcome.state) ?? 0) + 1);
  }

  console.log(`\n${"-".repeat(64)}`);
  for (const [state, count] of counts) console.log(`  ${String(count).padStart(4)}  ${state}`);

  if (options.dryRun) {
    console.log(
      "\n--dry-run: Gmail was not contacted and nothing was written.\n" +
        "Drop the flag to create the drafts.",
    );
    return;
  }
  if ((counts.get("in_gmail_drafts") ?? 0) > 0) {
    console.log(
      "\nThe drafts are in the connected Gmail account. Read them, edit anything\n" +
        "that reads like a machine wrote it, and send from there.",
    );
  }
}

type Campaign = {
  id: string;
  orgId: string;
  name: string;
  status: string;
  autoSend: boolean;
  dailyLimit: number;
  senderEmail: string | null;
  complianceAcknowledged: boolean;
  senderName: string;
  senderCompany: string | null;
};

async function loadCampaign(agentId?: string): Promise<Campaign | null> {
  let query = db
    .from("campaigns")
    .select(
      "id, org_id, agent_id, name, status, auto_send, daily_send_limit, sender_email, compliance_ack_at, agents(name, product_name)",
    )
    .order("created_at", { ascending: false })
    .limit(agentId ? 1 : 2);
  if (agentId) query = query.eq("agent_id", agentId);

  const { data, error } = await query;
  if (error) {
    console.error(`Could not read campaigns: ${error.message}`);
    return null;
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) {
    console.error(
      "No campaign exists yet. `npm run outreach:draft` creates one the first\n" +
        "time it writes a draft.",
    );
    return null;
  }
  if (!agentId && rows.length > 1) {
    console.error("Several campaigns. Name the agent with --agent <id>.");
    return null;
  }

  const row = rows[0];
  const agent = Array.isArray(row.agents)
    ? (row.agents[0] as Record<string, unknown> | undefined)
    : (row.agents as Record<string, unknown> | undefined);

  const productName = typeof agent?.product_name === "string" ? agent.product_name : null;

  return {
    id: String(row.id),
    orgId: String(row.org_id),
    name: typeof row.name === "string" ? row.name : "Campaign",
    status: typeof row.status === "string" ? row.status : "draft",
    autoSend: row.auto_send === true,
    dailyLimit: Number(row.daily_send_limit ?? CONSERVATIVE_DAILY_LIMIT),
    senderEmail: typeof row.sender_email === "string" ? row.sender_email : null,
    complianceAcknowledged: typeof row.compliance_ack_at === "string",
    senderName: productName ?? (typeof agent?.name === "string" ? agent.name : "Cătină"),
    senderCompany: productName,
  };
}

async function loadDue(campaign: Campaign, options: Options) {
  let query = db
    .from("messages")
    .select(DUE_MESSAGE_COLUMNS)
    .eq("campaign_id", campaign.id)
    // `approved` is what the queue screen sets; `drafted` is what the drafting
    // script writes. Both are sendable — the review gate is `auto_send`, not
    // this state, and requiring approval here would make the CLI path dead.
    .in("state", ["drafted", "approved"])
    .order("scheduled_for", { ascending: true })
    .limit(options.limit);

  if (!options.now) query = query.lte("scheduled_for", new Date().toISOString());

  const { data, error } = await query;
  if (error) {
    console.error(`Could not read messages: ${error.message}`);
    return [];
  }

  return (data ?? [])
    .map((row) => dueMessageFrom(row as Record<string, unknown>))
    .filter((message): message is NonNullable<typeof message> => message !== null);
}

main();
