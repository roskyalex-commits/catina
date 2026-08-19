/**
 * CAEN — the Romanian activity classification (the national implementation of
 * NACE Rev. 2).
 *
 * Every company in the trade register carries one 4-digit CAEN code, which
 * makes it the sharpest targeting filter available for Romanian B2B: "CAEN 4791
 * in Cluj with revenue over 1M RON" is a query no international prospecting
 * tool can express.
 *
 * The label table below is a curated subset — the sections that actually come
 * up in B2B prospecting — not the full ~600-code list. Unknown codes are
 * displayed rather than rejected, so an unusual but valid code still works.
 */

export const CAEN_LABELS: Record<string, string> = {
  // Manufacturing
  "1071": "Fabricarea pâinii și a produselor de panificație",
  "1101": "Distilarea băuturilor alcoolice",
  "1413": "Fabricarea altor articole de îmbrăcăminte",
  "1610": "Tăierea și rindeluirea lemnului",
  "2016": "Fabricarea materialelor plastice în forme primare",
  "2223": "Fabricarea articolelor din material plastic pentru construcții",
  "2511": "Fabricarea de construcții metalice",
  "2562": "Operațiuni de mecanică generală",
  "2733": "Fabricarea dispozitivelor de conexiune",
  "3101": "Fabricarea de mobilă pentru birouri și magazine",
  "3299": "Fabricarea altor produse manufacturiere",

  // Construction & real estate
  "4120": "Lucrări de construcții a clădirilor rezidențiale și nerezidențiale",
  "4213": "Construcția de poduri și tuneluri",
  "4321": "Lucrări de instalații electrice",
  "4322": "Lucrări de instalații sanitare și de încălzire",
  "4331": "Lucrări de ipsoserie",
  "4399": "Alte lucrări speciale de construcții",
  "6810": "Cumpărarea și vânzarea de bunuri imobiliare proprii",
  "6820": "Închirierea și subînchirierea bunurilor imobiliare",
  "6831": "Agenții imobiliare",

  // Wholesale & retail — the core of Romanian SMB prospecting
  "4511": "Comerț cu autoturisme și autovehicule ușoare",
  "4520": "Întreținerea și repararea autovehiculelor",
  "4619": "Intermedieri în comerțul cu produse diverse",
  "4631": "Comerț cu ridicata al fructelor și legumelor",
  "4639": "Comerț cu ridicata nespecializat de alimente și băuturi",
  "4641": "Comerț cu ridicata al produselor textile",
  "4649": "Comerț cu ridicata al altor bunuri de uz gospodăresc",
  "4651": "Comerț cu ridicata al calculatoarelor și software-ului",
  "4652": "Comerț cu ridicata de componente electronice",
  "4666": "Comerț cu ridicata al altor mașini de birou",
  "4690": "Comerț cu ridicata nespecializat",
  "4711": "Comerț cu amănuntul în magazine nespecializate (alimente predominant)",
  "4719": "Comerț cu amănuntul în magazine nespecializate",
  "4771": "Comerț cu amănuntul al îmbrăcămintei",
  "4776": "Comerț cu amănuntul al florilor și animalelor de companie",
  "4778": "Comerț cu amănuntul al altor bunuri noi, în magazine specializate",
  "4791": "Comerț cu amănuntul prin intermediul caselor de comenzi sau prin Internet",
  "4799": "Comerț cu amănuntul efectuat în afara magazinelor",

  // Transport & logistics
  "4941": "Transporturi rutiere de mărfuri",
  "5210": "Depozitări",
  "5229": "Alte activități anexe transporturilor",
  "5320": "Alte activități poștale și de curier",

  // Hospitality
  "5510": "Hoteluri și alte facilități de cazare similare",
  "5610": "Restaurante",
  "5630": "Baruri și alte activități de servire a băuturilor",

  // Information & communication — the SaaS/agency cluster
  "5811": "Activități de editare a cărților",
  "5814": "Activități de editare a revistelor și periodicelor",
  "5821": "Activități de editare a jocurilor de calculator",
  "5829": "Activități de editare a altor produse software",
  "5911": "Activități de producție cinematografică și video",
  "6010": "Activități de difuzare a programelor de radio",
  "6020": "Activități de difuzare a programelor de televiziune",
  "6110": "Activități de telecomunicații prin rețele cu cablu",
  "6120": "Activități de telecomunicații prin rețele fără cablu",
  "6201": "Activități de realizare a soft-ului la comandă",
  "6202": "Activități de consultanță în tehnologia informației",
  "6203": "Activități de management al mijloacelor de calcul",
  "6209": "Alte activități de servicii privind tehnologia informației",
  "6311": "Prelucrarea datelor, administrarea paginilor web",
  "6312": "Activități ale portalurilor web",
  "6399": "Alte activități de servicii informaționale",

  // Financial & professional services
  "6419": "Alte activități de intermedieri monetare",
  "6492": "Alte activități de creditare",
  "6499": "Alte intermedieri financiare",
  "6512": "Alte activități de asigurări (exceptând asigurările de viață)",
  "6622": "Activități ale agenților și broker-ilor de asigurări",
  "6920": "Activități de contabilitate și audit financiar; consultanță fiscală",
  "7022": "Activități de consultanță pentru afaceri și management",
  "7111": "Activități de arhitectură",
  "7112": "Activități de inginerie și consultanță tehnică",
  "7120": "Activități de testări și analize tehnice",
  "7211": "Cercetare-dezvoltare în biotehnologie",
  "7219": "Cercetare-dezvoltare în alte științe naturale și inginerie",
  "7311": "Activități ale agențiilor de publicitate",
  "7312": "Servicii de reprezentare media",
  "7320": "Activități de studiere a pieței și de sondare a opiniei publice",
  "7410": "Activități de design specializat",
  "7420": "Activități fotografice",
  "7430": "Activități de traducere scrisă și orală",

  // Administrative & support
  "7729": "Activități de închiriere a altor bunuri personale și gospodărești",
  "7810": "Activități ale agențiilor de plasare a forței de muncă",
  "7820": "Activități de contractare, pe baze temporare, a personalului",
  "7911": "Activități ale agențiilor turistice",
  "8020": "Activități de servicii privind sistemele de securizare",
  "8110": "Activități de servicii suport combinate",
  "8121": "Activități generale de curățenie a clădirilor",
  "8211": "Activități combinate de secretariat",
  "8220": "Activități ale centrelor de intermediere telefonică (call center)",
  "8299": "Alte activități de servicii suport pentru întreprinderi",

  // Education, health, other
  "8559": "Alte forme de învățământ",
  "8560": "Activități de servicii suport pentru învățământ",
  "8621": "Activități de asistență medicală generală",
  "8622": "Activități de asistență medicală specializată",
  "8623": "Activități de asistență stomatologică",
  "9602": "Coafură și alte activități de înfrumusețare",
  "9609": "Alte activități de servicii",
};

/**
 * CAEN sections, keyed by the leading two digits of the code. Used to group
 * codes in the UI and to widen a search when an exact code returns too few
 * companies.
 */
const SECTIONS: { range: [number, number]; label: string }[] = [
  { range: [1, 3], label: "Agriculture, forestry and fishing" },
  { range: [5, 9], label: "Mining and quarrying" },
  { range: [10, 33], label: "Manufacturing" },
  { range: [35, 35], label: "Electricity and gas" },
  { range: [36, 39], label: "Water supply and waste management" },
  { range: [41, 43], label: "Construction" },
  { range: [45, 47], label: "Wholesale and retail trade" },
  { range: [49, 53], label: "Transportation and storage" },
  { range: [55, 56], label: "Accommodation and food service" },
  { range: [58, 63], label: "Information and communication" },
  { range: [64, 66], label: "Financial and insurance activities" },
  { range: [68, 68], label: "Real estate activities" },
  { range: [69, 75], label: "Professional, scientific and technical" },
  { range: [77, 82], label: "Administrative and support services" },
  { range: [84, 84], label: "Public administration" },
  { range: [85, 85], label: "Education" },
  { range: [86, 88], label: "Human health and social work" },
  { range: [90, 93], label: "Arts, entertainment and recreation" },
  { range: [94, 96], label: "Other service activities" },
];

export function isValidCaen(code: string): boolean {
  return /^\d{4}$/.test(code.trim());
}

/** Human-readable label, falling back to the bare code for anything uncurated. */
export function caenLabel(code: string): string {
  const trimmed = code.trim();
  return CAEN_LABELS[trimmed] ?? `CAEN ${trimmed}`;
}

export function caenSection(code: string): string | null {
  if (!isValidCaen(code)) return null;
  const division = Number(code.slice(0, 2));
  const section = SECTIONS.find(
    (s) => division >= s.range[0] && division <= s.range[1],
  );
  return section?.label ?? null;
}

/**
 * Widen a set of codes to their two-digit divisions.
 *
 * A registry query on exact codes can be too narrow — an ICP targeting "6201
 * custom software" usually also wants 6202 and 6209. Callers use this as the
 * fallback when an exact-code search comes back thin.
 */
export function caenDivisions(codes: string[]): string[] {
  return [
    ...new Set(codes.filter(isValidCaen).map((c) => c.trim().slice(0, 2))),
  ];
}

/** Normalises free-form user input into valid, deduped codes. */
export function parseCaenCodes(input: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of input) {
    const code = raw.trim();
    if (isValidCaen(code)) seen.add(code);
  }
  return [...seen];
}
