/**
 * The industry vocabulary a seller actually uses, and the NACE prefixes each
 * one covers.
 *
 * Chosen by "would a Romanian B2B seller name this as their segment", not by
 * walking the NACE tree. There is no industry here for "manufacture of
 * prepared animal feeds" — nobody sells *to* that as a segment — but there is
 * one for "e-commerce", which is not a NACE division at all.
 *
 * ## Why prefixes rather than codes
 *
 * CAEN is Romania's implementation of NACE, and the register mixes **four**
 * revisions: 1998, 2003, 2008 (NACE Rev. 2) and 2025 (NACE Rev. 2.1). Two are
 * live in our data — ANAF files the 2008 codes, ONRC now lists the 2025 ones —
 * and the 2025 revision renumbered heavily:
 *
 *   custom software        6201 (2008)  →  6210 (2025)
 *   IT consultancy         6202 + 6203  →  6220        (merged)
 *   other IT services      6209         →  6290
 *   data processing        6311         →  6310
 *   web portals            6312         →  6391
 *
 * Both spellings are in `companies.caen` right now — 2,263 rows on 6201 and
 * 2,714 on 6210 — so an industry that lists one and not the other silently
 * halves its own reach. Writing a division prefix instead and expanding it
 * against the official nomenclator per revision is the only way to get that
 * right without maintaining the mapping by hand.
 *
 * The expansion, the labels and the conflict list are generated into
 * `nace-codes.generated.ts` by `npm run build:industries`, which reads
 * `n_caen.csv` from the ONRC open-data export. **Do not hand-edit the
 * generated file** — add or change a prefix here and re-run.
 *
 * ## Conflicts
 *
 * A code can mean different things in different revisions. `6391` is "news
 * agencies" in 2008 and "web portals" in 2025; `2051` went from explosives to
 * liquid biofuels. Where one code would land in two industries the generator
 * drops it from both and records it, because a code that means two things
 * cannot target either honestly.
 */

export type IndustryDefinition = {
  /** Stable key. Stored on the agent; never renamed once shipped. */
  key: string;
  label: string;
  labelRo: string;
  /**
   * NACE prefixes: a 2-digit division, 3-digit group, or exact 4-digit class.
   * Expanded against every live revision unless one is named with `@`:
   * `"4791@2"` claims that class in CAEN 2008 and not in CAEN 2025.
   *
   * A more specific claim wins. `retail` takes the whole of `47` and
   * `ecommerce` takes `4791` out of it, which is nesting rather than a
   * conflict — the generator resolves that by prefix length.
   */
  nace: readonly string[];
  /** What a user or a model might call this instead. Matched folded. */
  aliases: readonly string[];
};

export const INDUSTRY_DEFINITIONS: readonly IndustryDefinition[] = [
  {
    key: "software",
    label: "Software & IT services",
    labelRo: "Software și servicii IT",
    // The whole division, so 6201/6210, 6202+6203/6220 and 6209/6290 are all
    // covered without naming a single revision.
    nace: ["62"],
    aliases: ["software", "it", "saas", "software development", "dezvoltare software", "programare", "tech"],
  },
  {
    key: "it_infrastructure",
    label: "Hosting, data & web infrastructure",
    labelRo: "Găzduire, date și infrastructură web",
    nace: ["63"],
    aliases: ["hosting", "cloud", "data processing", "gazduire", "infrastructura", "datacenter"],
  },
  {
    key: "ecommerce",
    label: "E-commerce",
    labelRo: "Comerț online",
    /*
     * CAEN 2008 only, and this is the most important footnote in the file.
     *
     * `4791` meant "retail via mail order or the Internet" under CAEN 2008 —
     * it is the class that meant "online shop", and 344 companies in our data
     * still carry it. **CAEN 2025 abolished the distinction entirely.** NACE
     * Rev. 2.1 classifies an online seller by *what* it sells rather than how,
     * and repurposed `4791` to "intermediation in non-specialised retail".
     *
     * So e-commerce is a targetable industry code only for companies
     * registered before the new revision, and becomes progressively less
     * discoverable from the register over time. The reliable way to identify an
     * online shop is the technology on its site — Shopify, WooCommerce,
     * PrestaShop, Gomag, MerchantPro are all in `TECH_MARKERS` — which is
     * exactly what `competitor_tech` and `tech_stack` already read.
     *
     * Do not "fix" this by adding a 2025 code. There is not one.
     */
    nace: ["4791@2"],
    aliases: ["ecommerce", "e-commerce", "online retail", "magazin online", "comert online", "webshop"],
  },
  {
    key: "retail",
    label: "Retail",
    labelRo: "Comerț cu amănuntul",
    nace: ["47"],
    aliases: ["retail", "shop", "magazin", "comert cu amanuntul", "store"],
  },
  {
    key: "wholesale",
    label: "Wholesale & distribution",
    labelRo: "Comerț cu ridicata și distribuție",
    nace: ["46"],
    aliases: ["wholesale", "distribution", "distributie", "en gros", "comert cu ridicata", "importator"],
  },
  {
    key: "marketing_agency",
    label: "Marketing & advertising",
    labelRo: "Marketing și publicitate",
    nace: ["73"],
    aliases: ["marketing", "advertising", "agency", "publicitate", "agentie", "media buying", "pr"],
  },
  {
    key: "management_consulting",
    label: "Management consulting",
    labelRo: "Consultanță în management",
    nace: ["70"],
    aliases: ["consulting", "consultanta", "management consulting", "business consulting", "strategy"],
  },
  {
    key: "accounting_legal",
    label: "Accounting, audit & legal",
    labelRo: "Contabilitate, audit și servicii juridice",
    nace: ["69"],
    aliases: ["accounting", "contabilitate", "audit", "legal", "avocat", "juridic", "expert contabil", "fiscal"],
  },
  {
    key: "engineering_architecture",
    label: "Engineering & architecture",
    labelRo: "Inginerie și arhitectură",
    nace: ["71"],
    aliases: ["engineering", "architecture", "inginerie", "arhitectura", "proiectare", "design tehnic"],
  },
  {
    key: "hr_recruitment",
    label: "HR & recruitment",
    labelRo: "Resurse umane și recrutare",
    nace: ["78"],
    aliases: ["hr", "recruitment", "recrutare", "resurse umane", "staffing", "headhunting", "leasing de personal"],
  },
  {
    key: "construction",
    label: "Construction",
    labelRo: "Construcții",
    nace: ["41", "42", "43"],
    aliases: ["construction", "constructii", "building", "antrepriza", "instalatii", "santier"],
  },
  {
    key: "real_estate",
    label: "Real estate",
    labelRo: "Imobiliare",
    nace: ["68"],
    aliases: ["real estate", "imobiliare", "property", "dezvoltator imobiliar", "agentie imobiliara"],
  },
  {
    key: "food_beverage",
    label: "Food & beverage production",
    labelRo: "Producție alimentară și băuturi",
    nace: ["10", "11"],
    aliases: ["food", "beverage", "alimentar", "bauturi", "producator alimente", "fmcg", "panificatie"],
  },
  {
    key: "textiles_apparel",
    label: "Textiles & apparel",
    labelRo: "Textile și confecții",
    nace: ["13", "14", "15"],
    aliases: ["textiles", "apparel", "fashion", "textile", "confectii", "incaltaminte", "imbracaminte"],
  },
  {
    key: "wood_furniture",
    label: "Wood & furniture",
    labelRo: "Lemn și mobilier",
    nace: ["16", "31"],
    aliases: ["wood", "furniture", "lemn", "mobila", "mobilier", "cherestea"],
  },
  {
    key: "printing_packaging",
    label: "Printing & packaging",
    labelRo: "Tipografie și ambalaje",
    nace: ["17", "18"],
    aliases: ["printing", "packaging", "tipografie", "ambalaje", "print", "hartie", "carton"],
  },
  {
    key: "chemicals_pharma",
    label: "Chemicals & pharmaceuticals",
    labelRo: "Chimie și farmaceutice",
    nace: ["20", "21"],
    aliases: ["chemicals", "pharma", "chimie", "farmaceutic", "medicamente", "cosmetice"],
  },
  {
    key: "metal_products",
    label: "Metal & fabricated products",
    labelRo: "Metalurgie și produse din metal",
    nace: ["24", "25"],
    aliases: ["metal", "steel", "metalurgie", "confectii metalice", "prelucrare metal", "otel"],
  },
  {
    key: "electronics",
    label: "Electronics & instruments",
    labelRo: "Electronice și aparatură",
    nace: ["26", "27"],
    aliases: ["electronics", "electronice", "electrotehnica", "aparatura", "componente"],
  },
  {
    key: "machinery",
    label: "Machinery & equipment",
    labelRo: "Utilaje și echipamente",
    nace: ["28"],
    aliases: ["machinery", "equipment", "utilaje", "echipamente", "masini industriale"],
  },
  {
    key: "automotive",
    label: "Automotive",
    labelRo: "Auto",
    nace: ["29", "30", "45"],
    aliases: ["automotive", "auto", "car", "vehicule", "piese auto", "service auto", "dealer auto"],
  },
  {
    key: "logistics_transport",
    label: "Transport & logistics",
    labelRo: "Transport și logistică",
    nace: ["49", "50", "51", "52", "53"],
    aliases: ["logistics", "transport", "shipping", "logistica", "curierat", "transportator", "depozitare", "freight"],
  },
  {
    key: "hospitality",
    label: "Hotels & restaurants",
    labelRo: "Hoteluri și restaurante",
    nace: ["55", "56"],
    aliases: ["hospitality", "hotel", "restaurant", "horeca", "cazare", "catering", "cafenea"],
  },
  {
    key: "tourism",
    label: "Travel & tourism",
    labelRo: "Turism și agenții de voiaj",
    nace: ["79"],
    aliases: ["tourism", "travel", "turism", "agentie de turism", "tour operator"],
  },
  {
    key: "healthcare",
    label: "Healthcare",
    labelRo: "Sănătate",
    nace: ["86", "87"],
    aliases: ["healthcare", "medical", "sanatate", "clinica", "cabinet medical", "stomatologie", "spital"],
  },
  {
    key: "education_training",
    label: "Education & training",
    labelRo: "Educație și formare",
    nace: ["85"],
    aliases: ["education", "training", "educatie", "scoala", "cursuri", "formare profesionala", "edtech"],
  },
  {
    key: "financial_services",
    label: "Financial services & insurance",
    labelRo: "Servicii financiare și asigurări",
    nace: ["64", "65", "66"],
    aliases: ["finance", "financial", "banking", "insurance", "financiar", "asigurari", "leasing", "ifn", "fintech"],
  },
  {
    key: "energy_utilities",
    label: "Energy, utilities & waste",
    labelRo: "Energie, utilități și deșeuri",
    nace: ["35", "36", "37", "38", "39"],
    aliases: ["energy", "utilities", "energie", "utilitati", "deseuri", "reciclare", "fotovoltaic", "apa"],
  },
  {
    key: "agriculture",
    label: "Agriculture & farming",
    labelRo: "Agricultură",
    nace: ["01", "02", "03"],
    // Not "cultura": in Romanian it is both crop cultivation and culture, and
    // it would resolve agriculture and the arts to each other.
    aliases: ["agriculture", "farming", "agricultura", "ferma", "agro", "zootehnie", "culturi agricole"],
  },
  {
    key: "media_publishing",
    label: "Media & publishing",
    labelRo: "Media și editură",
    nace: ["58", "59", "60"],
    aliases: ["media", "publishing", "editura", "productie video", "radio", "televiziune", "film"],
  },
  {
    key: "telecom",
    label: "Telecommunications",
    labelRo: "Telecomunicații",
    nace: ["61"],
    aliases: ["telecom", "telecommunications", "telecomunicatii", "isp", "internet provider"],
  },
  {
    key: "facilities_security",
    label: "Facilities & security services",
    labelRo: "Servicii de pază și administrare clădiri",
    nace: ["80", "81"],
    aliases: ["facilities", "security", "cleaning", "paza", "curatenie", "administrare cladiri", "peisagistica"],
  },
  {
    key: "business_support",
    label: "Business support services",
    labelRo: "Servicii suport pentru afaceri",
    nace: ["82"],
    aliases: ["business support", "bpo", "call center", "outsourcing", "servicii suport", "secretariat"],
  },
  {
    key: "repair_maintenance",
    label: "Repair & installation",
    labelRo: "Reparații și instalare",
    nace: ["33", "95"],
    aliases: ["repair", "maintenance", "reparatii", "mentenanta", "service", "instalare echipamente"],
  },
  {
    key: "arts_entertainment",
    label: "Arts, sport & entertainment",
    labelRo: "Artă, sport și divertisment",
    nace: ["90", "91", "93"],
    aliases: ["arts", "entertainment", "sport", "divertisment", "cultural", "evenimente", "fitness"],
  },
  {
    key: "nonprofit",
    label: "Associations & non-profit",
    labelRo: "Asociații și ONG",
    nace: ["94"],
    aliases: ["nonprofit", "ngo", "ong", "asociatie", "fundatie", "non-profit", "patronat"],
  },
  {
    key: "public_sector",
    label: "Public administration",
    labelRo: "Administrație publică",
    nace: ["84"],
    aliases: ["public sector", "government", "administratie publica", "primarie", "institutie publica"],
  },
];
