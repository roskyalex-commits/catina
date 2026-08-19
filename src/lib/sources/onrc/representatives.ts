/**
 * Legal representatives from OD_REPREZENTANTI_LEGALI.
 *
 * This is the file that answers "who do I actually contact". For a Romanian
 * SRL the `administrator` is usually the owner, and for the SMBs this product
 * targets that is the person who decides on a purchase — obtained from the
 * official register rather than from a paid enrichment vendor.
 *
 * Two things shape everything below.
 *
 * **Data minimisation.** The export carries date of birth, place of birth and
 * home locality for roughly 89% of natural persons. None of that is needed to
 * send a business email, and name + date of birth + place of birth is a strong
 * identifier for a private individual. So the birth columns are read only to
 * tell a person from a company, and are never stored. Same reasoning as
 * keeping the database in Frankfurt: minimising what is held is cheaper than
 * defending why it is held.
 *
 * **Most rows are not decision-makers.** Insolvency practitioners —
 * `lichidator`, `administrator judiciar` and their variants — outnumber
 * administrators, and are attached to companies in difficulty. They are
 * excluded: they are not buyers, and mailing them would be embarrassing.
 */

/** Roles worth contacting: the people who run the company. */
export const DECISION_MAKER_ROLES = new Set([
  "administrator",
  "administrator si reprezentant",
  "reprezentant legal",
  "director general unic",
  "reprezentant al persoanei juridice",
  "membru in consiliul de supraveghere",
  "presedinte consiliu de administratie",
]);

/**
 * Court-appointed roles, excluded.
 *
 * Their presence is itself a distress signal — a company with a `lichidator`
 * is being wound up — but that belongs in the signals engine, not in a list of
 * people to email.
 */
export const INSOLVENCY_ROLE_MARKERS = [
  "lichidator",
  "judiciar",
  "concordatar",
  "special",
  "provizoriu",
];

/** Fold a role for comparison: lower case, no diacritics, single spaces. */
export function normaliseRole(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șşŞȘ]/g, "s")
    .replace(/[țţŢȚ]/g, "t")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/** Is this a role we would contact? */
export function isDecisionMakerRole(raw: string): boolean {
  const role = normaliseRole(raw);
  if (!role) return false;
  if (INSOLVENCY_ROLE_MARKERS.some((marker) => role.includes(marker))) {
    return false;
  }
  return DECISION_MAKER_ROLES.has(role) || role.startsWith("administrator");
}

/**
 * Legal-form markers that mean the "representative" is a company.
 *
 * A company can administer another company, and those rows are common. They
 * carry no birth data, which is the other tell — but the name is the reliable
 * one, since a natural person's birth fields are occasionally blank too.
 */
const COMPANY_MARKERS = [
  // Romanian
  "srl", "s r l", "srld", "sa", "s a", "sca", "snc", "scs", "sprl", "ipurl",
  "cii", "c i i", "cabinet", "societate", "sc", "url",
  // Foreign forms, which appear whenever a foreign parent administers a
  // Romanian subsidiary — common enough to matter and easy to miss.
  "sarl", "sarlu", "eurl", "sas", "sasu", "kft", "zrt", "rt", "bt", "kkt",
  "sro", "s r o", "spol", "as", "aps", "ab", "oy", "oyj", "asa", "doo",
  "dooel", "ood", "eood", "ead", "ad", "sp", "spzoo", "zoo", "sl", "slu",
  "spa", "srls", "bvba", "cvba", "vof",
  "inc", "ltd", "limited", "llp", "lp", "gmbh", "mbh", "ug", "kg", "ohg",
  "bv", "nv", "ag", "plc", "llc", "lc", "corp", "co", "company", "holding",
  "group", "international", "trust", "partners", "consulting",
];

/**
 * Romanian sole-trader forms.
 *
 * A PFA or întreprindere individuală *is* a natural person trading under a
 * registered name, so these are not companies — but the entity suffix should
 * not end up in the greeting. They are stripped rather than rejected.
 */
const SOLE_TRADER_SUFFIXES = [
  /\s+persoan[aă]\s+fizic[aă]\s+autorizat[aă]\s*$/iu,
  /\s+[îi]ntreprindere\s+individual[aă]\s*$/iu,
  /\s+[îi]ntreprindere\s+familial[aă]\s*$/iu,
  /\s+p\.?\s?f\.?\s?a\.?\s*$/iu,
  /\s+i\.?\s?i\.?\s*$/iu,
  /\s+i\.?\s?f\.?\s*$/iu,
];

/** Remove a sole-trader suffix, leaving the person's name. */
export function stripSoleTraderSuffix(name: string): string {
  let value = name.trim().replace(/\s+/g, " ");
  for (const pattern of SOLE_TRADER_SUFFIXES) {
    value = value.replace(pattern, "");
  }
  return value.trim();
}

/**
 * Does this name belong to a natural person?
 *
 * Conservative in the direction that matters: anything that looks like a
 * company is treated as one. Importing a company into `people` would produce a
 * "Dear KPMG Romania SRL" opener, which is worse than missing a contact.
 */
export function isNaturalPerson(name: string, hasBirthData: boolean): boolean {
  const trimmed = stripSoleTraderSuffix(name);
  if (trimmed.length < 4) return false;

  const tokens = normaliseRole(trimmed).split(" ").filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some((token) => COMPANY_MARKERS.includes(token))) return false;

  // Punctuation-heavy names are practice titles ("C.I.I. SAVA CATRINEL").
  if (/[.,&"']/.test(trimmed) && !hasBirthData) return false;

  // A person has at least a surname and a given name.
  if (tokens.length < 2) return false;

  return true;
}

export type Representative = {
  regNumber: string;
  fullName: string;
  /** The register's own Romanian wording, kept for display. */
  role: string;
};

/**
 * Tidy the name for display.
 *
 * The register writes names in upper case with irregular spacing. Title case
 * reads better in an email and in the UI, and hyphenated given names — common
 * in Romanian — keep their capitals on both halves.
 */
export function tidyName(raw: string): string {
  return stripSoleTraderSuffix(raw)
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ro-RO")
    .replace(/(^|[\s\-'])(\p{L})/gu, (_, prefix: string, letter: string) =>
      prefix + letter.toLocaleUpperCase("ro-RO"),
    );
}
