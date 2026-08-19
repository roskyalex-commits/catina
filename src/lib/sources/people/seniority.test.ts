import { describe, expect, it } from "vitest";
import { classifySeniority, isDecisionMaker, scoreTitleMatch } from "./seniority";

/**
 * The classifier decides who counts as a decision-maker, so it decides the
 * spike's headline number. The Romanian cases are the ones that matter most:
 * "Director General" is a CEO, and misfiling it as a director would push the
 * single most valuable Romanian buyer persona into the wrong bucket.
 */

describe("classifySeniority — English", () => {
  it("recognises founders and owners", () => {
    expect(classifySeniority("Founder")).toBe("founder");
    expect(classifySeniority("Co-Founder & CEO")).toBe("founder");
    expect(classifySeniority("Owner")).toBe("founder");
  });

  it("recognises C-level, including spelled-out chief roles", () => {
    expect(classifySeniority("CEO")).toBe("c_level");
    expect(classifySeniority("Chief Marketing Officer")).toBe("c_level");
    expect(classifySeniority("Chief Information Security Officer")).toBe("c_level");
    expect(classifySeniority("Managing Director")).toBe("c_level");
  });

  it("separates VP from director and head", () => {
    expect(classifySeniority("VP of Engineering")).toBe("vp");
    expect(classifySeniority("Senior Vice President, Sales")).toBe("vp");
    expect(classifySeniority("Head of Growth")).toBe("head");
    expect(classifySeniority("Marketing Director")).toBe("director");
  });

  it("recognises managers and individual contributors", () => {
    expect(classifySeniority("Product Manager")).toBe("manager");
    expect(classifySeniority("Engineering Team Lead")).toBe("manager");
    expect(classifySeniority("Senior Software Engineer")).toBe("individual_contributor");
    expect(classifySeniority("Data Analyst")).toBe("individual_contributor");
  });

  it("does not mistake a founding engineer for a founder", () => {
    // "founding" shares a stem with "founder"; anchoring on the noun avoids
    // promoting an IC into the top bucket.
    expect(classifySeniority("Founding Engineer")).toBe("individual_contributor");
  });

  it("returns undefined for an unrecognised or empty title", () => {
    expect(classifySeniority("")).toBeUndefined();
    expect(classifySeniority(undefined)).toBeUndefined();
    expect(classifySeniority("Ninja Rockstar")).toBeUndefined();
  });
});

describe("classifySeniority — Romanian", () => {
  it("treats Director General and Administrator as C-level, not director", () => {
    // The single most important mapping in this file.
    expect(classifySeniority("Director General")).toBe("c_level");
    expect(classifySeniority("Administrator")).toBe("c_level");
    expect(classifySeniority("Director Executiv")).toBe("c_level");
  });

  it("still classifies a functional Romanian director as director", () => {
    expect(classifySeniority("Director de Marketing")).toBe("director");
    expect(classifySeniority("Director Comercial")).toBe("director");
  });

  it("recognises Romanian founders and shareholders", () => {
    expect(classifySeniority("Fondator")).toBe("founder");
    expect(classifySeniority("Proprietar")).toBe("founder");
    expect(classifySeniority("Acționar principal")).toBe("founder");
  });

  it("matches titles written with or without diacritics", () => {
    // Romanian titles appear both ways on LinkedIn, interchangeably.
    expect(classifySeniority("Șef Departament Vânzări")).toBe("head");
    expect(classifySeniority("Sef Departament Vanzari")).toBe("head");
    expect(classifySeniority("Acţionar")).toBe("founder");
  });

  it("recognises Romanian managers and ICs", () => {
    expect(classifySeniority("Coordonator Proiect")).toBe("manager");
    expect(classifySeniority("Responsabil Achizitii")).toBe("manager");
    expect(classifySeniority("Contabil Sef")).toBe("individual_contributor");
    expect(classifySeniority("Programator")).toBe("individual_contributor");
  });
});

describe("scoreTitleMatch", () => {
  const icp = {
    targetTitles: ["CEO", "Marketing Director"],
    targetSeniorities: ["founder", "c_level"] as const,
  };

  it("scores an exact title match highest", () => {
    expect(scoreTitleMatch("CEO", { ...icp, targetSeniorities: [...icp.targetSeniorities] })).toBe(1);
  });

  it("scores a partial title match just below exact", () => {
    expect(
      scoreTitleMatch("Marketing Director, EMEA", {
        ...icp,
        targetSeniorities: [...icp.targetSeniorities],
      }),
    ).toBe(0.85);
  });

  it("falls back to the seniority bucket when no title matches", () => {
    // "Fondator" is in no target title, but is a founder — still a buyer.
    expect(
      scoreTitleMatch("Fondator", {
        ...icp,
        targetSeniorities: [...icp.targetSeniorities],
      }),
    ).toBe(0.6);
  });

  it("scores an out-of-scope title zero", () => {
    expect(
      scoreTitleMatch("Junior Developer", {
        ...icp,
        targetSeniorities: [...icp.targetSeniorities],
      }),
    ).toBe(0);
  });

  it("ignores diacritics when matching target titles", () => {
    expect(
      scoreTitleMatch("Director de Marketing", {
        targetTitles: ["Director de Marketing"],
        targetSeniorities: [],
      }),
    ).toBe(1);
  });

  it("scores an empty title zero rather than throwing", () => {
    expect(
      scoreTitleMatch(undefined, { targetTitles: ["CEO"], targetSeniorities: [] }),
    ).toBe(0);
  });
});

describe("isDecisionMaker", () => {
  const icp = {
    targetTitles: ["CEO"],
    targetSeniorities: ["founder", "c_level"] as ("founder" | "c_level")[],
  };

  it("counts a seniority-bucket match", () => {
    expect(isDecisionMaker("Director General", icp)).toBe(true);
  });

  it("excludes ICs and managers", () => {
    expect(isDecisionMaker("Software Engineer", icp)).toBe(false);
    expect(isDecisionMaker("Product Manager", icp)).toBe(false);
  });

  it("excludes an unknown title rather than guessing generously", () => {
    // Over-counting here would inflate the spike's coverage figure and argue
    // against a crawler we might actually need.
    expect(isDecisionMaker("Ninja Rockstar", icp)).toBe(false);
  });
});
