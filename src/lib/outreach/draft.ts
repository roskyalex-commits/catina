import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Signal } from "@/lib/signals/types";

/**
 * Message drafting.
 *
 * The rule that makes this worth doing at all: a message is only drafted when
 * there is a specific signal to open with. Generic personalisation ("I saw
 * you're in software") is what recipients recognise as automated, and it is
 * exactly what a template with merge fields already produces for free.
 *
 * Romanian recipients get Romanian copy. Writing to a Romanian SMB in English
 * is a stronger negative signal than any amount of personalisation is positive.
 */

const draftSchema = z.object({
  subject: z
    .string()
    .describe(
      "Under 60 characters, lowercase-ish and specific. No colons, no marketing " +
        "phrasing, nothing that reads like a subject line from a sequence tool.",
    ),
  body: z
    .string()
    .describe(
      "Under 120 words. Opens with the specific trigger, states what you do in one " +
        "line, ends with a low-friction question. No pleasantries, no bullet lists, " +
        "no 'I hope this finds you well'.",
    ),
  /** Forces the model to name its hook, which makes a generic draft detectable. */
  openingHook: z
    .string()
    .describe("The specific fact from the signal that the opening line uses."),
});

export type Draft = {
  subject: string;
  body: string;
  openingHook: string;
  language: "ro" | "en";
  signalDedupeKey?: string;
};

export type DraftInput = {
  /** The seller's own value proposition, from onboarding. */
  valueProp: string;
  senderName: string;
  senderCompany?: string;
  recipientName: string;
  recipientTitle?: string;
  companyName: string;
  /** The signal the message is built around. Required — see the note above. */
  signal: Signal;
  language: "ro" | "en";
  /** Prior messages in the sequence, so a follow-up doesn't repeat itself. */
  previousMessages?: { subject: string; body: string }[];
};

const SYSTEM_PROMPT = `You write short B2B outreach emails that a busy person will actually answer.

You are given one specific, verifiable fact about the recipient's company — a filing, a job posting, a news item — and the sender's value proposition. Build the message around that fact.

What makes these work:

Open with the trigger, concretely. Not "I saw you're growing" but "saw you're hiring a Marketing Director". The recipient should be able to tell you looked at something real.

Connect the trigger to the offer in one sentence. If you cannot draw that line honestly, say less rather than inventing a connection — an obviously bolted-on pitch reads worse than a short note.

Close with a question that costs nothing to answer. Not a meeting request with three time slots.

What kills them: "I hope this finds you well", "I wanted to reach out", "quick question" as a subject, flattery, bullet lists, more than one call to action, and any claim about the recipient you cannot support from the fact you were given.

Length is a feature. Under 120 words. Shorter is better if the point lands.

When writing in Romanian, write as a Romanian speaker would to a business contact: address them with "dumneavoastră", keep it direct rather than florid, and never produce translated-sounding English idiom. Romanian business email is more formal than English but not ornate.`;

export async function draftMessage(
  input: DraftInput,
  apiKey: string,
): Promise<Draft> {
  const client = new Anthropic({ apiKey });

  const message = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPrompt(input) }],
    output_config: { format: zodOutputFormat(draftSchema) },
  });

  if (message.stop_reason === "refusal" || !message.parsed_output) {
    throw new Error("Could not draft a message for this lead.");
  }

  return {
    ...normalise(message.parsed_output),
    language: input.language,
    signalDedupeKey: input.signal.dedupeKey,
  };
}

function buildPrompt(input: DraftInput): string {
  const parts = [
    `Write in: ${input.language === "ro" ? "Romanian" : "English"}`,
    "",
    `<sender>`,
    `${input.senderName}${input.senderCompany ? `, ${input.senderCompany}` : ""}`,
    `What they sell: ${input.valueProp}`,
    `</sender>`,
    "",
    `<recipient>`,
    `${input.recipientName}${input.recipientTitle ? `, ${input.recipientTitle}` : ""} at ${input.companyName}`,
    `</recipient>`,
    "",
    `<trigger>`,
    input.signal.title,
    input.signal.evidenceUrl ? `Source: ${input.signal.evidenceUrl}` : "",
    `</trigger>`,
  ];

  if (input.previousMessages?.length) {
    parts.push(
      "",
      "<already_sent>",
      // Given verbatim so the follow-up can be genuinely additive rather than
      // a reworded repeat.
      ...input.previousMessages.map(
        (m) => `Subject: ${m.subject}\n${m.body}`,
      ),
      "</already_sent>",
      "",
      "This is a follow-up. Add something new — do not restate the first message.",
    );
  }

  return parts.filter((p) => p !== "").join("\n");
}

/**
 * Cleans up the output and rejects drafts that leaked a template.
 *
 * A model occasionally emits a placeholder it was never given a value for.
 * Sending "Hi [First Name]" is worse than sending nothing, so this throws
 * rather than passing it along.
 */
export function normalise(raw: z.infer<typeof draftSchema>): {
  subject: string;
  body: string;
  openingHook: string;
} {
  const subject = raw.subject.trim().replace(/\s+/g, " ");
  const body = raw.body.trim().replace(/\n{3,}/g, "\n\n");

  const placeholder = findPlaceholder(`${subject}\n${body}`);
  if (placeholder) {
    throw new Error(
      `Draft contained an unfilled placeholder (${placeholder}) and was discarded.`,
    );
  }

  if (!subject) throw new Error("Draft had no subject.");
  if (body.length < 20) throw new Error("Draft body was too short to send.");

  return { subject, body, openingHook: raw.openingHook.trim() };
}

const PLACEHOLDER_PATTERNS = [
  /\[[^\]]{2,40}\]/, // [First Name]
  /\{\{[^}]{1,40}\}\}/, // {{company}}
  /\{[A-Za-z_][A-Za-z0-9_ ]{1,30}\}/, // {company_name}
  /\bXXX+\b/i,
  /\bTODO\b/i,
  /\b(your company|company name|first name|prenume)\b/i,
];

export function findPlaceholder(text: string): string | null {
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

/** Romanian recipients get Romanian copy; everyone else gets English. */
export function draftLanguageFor(country: string | undefined | null): "ro" | "en" {
  return country?.trim().toUpperCase() === "RO" ? "ro" : "en";
}
