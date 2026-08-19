import { describe, expect, it } from "vitest";
import { draftLanguageFor, findPlaceholder, normalise } from "./draft";

/**
 * The model call itself needs a network, but the guard around it does not —
 * and the guard is the part that matters. Sending "Hi [First Name]" is worse
 * than sending nothing, so a leaked placeholder must abort the draft rather
 * than pass through.
 */

const valid = {
  subject: "hiring a marketing director",
  body:
    "Salut Ana,\n\nAm văzut că angajați un Director de Marketing. Noi automatizăm " +
    "facturarea pentru firme care cresc rapid.\n\nMerită o discuție de 10 minute?",
  openingHook: "Hiring a Marketing Director",
};

describe("findPlaceholder", () => {
  it("catches square-bracket merge fields", () => {
    expect(findPlaceholder("Hi [First Name],")).toBe("[First Name]");
  });

  it("catches handlebars and single-brace templates", () => {
    expect(findPlaceholder("Hello {{company}}")).toBe("{{company}}");
    expect(findPlaceholder("Hello {company_name}")).toBe("{company_name}");
  });

  it("catches unfilled prose placeholders in both languages", () => {
    expect(findPlaceholder("I work with your company on this")).toMatch(
      /your company/i,
    );
    expect(findPlaceholder("Buna, prenume")).toMatch(/prenume/i);
  });

  it("catches leftover scaffolding", () => {
    expect(findPlaceholder("TODO: add value prop")).toMatch(/TODO/i);
    expect(findPlaceholder("Contact XXX for details")).toMatch(/XXX/i);
  });

  it("does not fire on ordinary prose", () => {
    expect(findPlaceholder(valid.body)).toBeNull();
    expect(findPlaceholder("Saw you're hiring a Marketing Director.")).toBeNull();
  });

  it("does not fire on normal punctuation or Romanian text", () => {
    expect(findPlaceholder("Costurile scad cu 30% (în medie).")).toBeNull();
    expect(findPlaceholder("Mulțumesc, Ștefan")).toBeNull();
  });
});

describe("normalise", () => {
  it("passes a clean draft through, tidying whitespace", () => {
    const result = normalise({
      ...valid,
      subject: "  hiring   a  marketing director  ",
      body: `${valid.body}\n\n\n\n`,
    });

    expect(result.subject).toBe("hiring a marketing director");
    expect(result.body).not.toMatch(/\n{3,}/);
  });

  it("discards a draft containing a placeholder", () => {
    // The important one: this must throw, not sanitise and send.
    expect(() =>
      normalise({ ...valid, body: "Hi [First Name],\n\nWe help companies grow." }),
    ).toThrow(/placeholder/i);
  });

  it("names the placeholder it found, for the error log", () => {
    expect(() => normalise({ ...valid, subject: "re: {{company}}" })).toThrow(
      /\{\{company\}\}/,
    );
  });

  it("rejects an empty subject", () => {
    expect(() => normalise({ ...valid, subject: "   " })).toThrow(/no subject/i);
  });

  it("rejects a body too short to be a real message", () => {
    expect(() => normalise({ ...valid, body: "Hi" })).toThrow(/too short/i);
  });
});

describe("draftLanguageFor", () => {
  it("writes to Romanian recipients in Romanian", () => {
    // Writing to a Romanian SMB in English is a stronger negative signal than
    // any amount of personalisation is positive.
    expect(draftLanguageFor("RO")).toBe("ro");
    expect(draftLanguageFor(" ro ")).toBe("ro");
  });

  it("defaults to English elsewhere and when unknown", () => {
    expect(draftLanguageFor("GB")).toBe("en");
    expect(draftLanguageFor(undefined)).toBe("en");
    expect(draftLanguageFor(null)).toBe("en");
  });
});
