import type { FacilityRecord } from "./types";

export type AllocFilterKey =
  | "all"
  | "nep_only"
  | "hgab_only"
  | "senate_only"
  | "nep_hgab"
  | "nep_senate"
  | "hgab_senate"
  | "nep_hgab_senate"
  | "all_nep"
  | "all_hgab"
  | "all_senate";

export const ALLOC_OPTIONS: Array<{ key: AllocFilterKey; label: string }> = [
  { key: "all", label: "All allocation sources" },
  { key: "nep_only", label: "NEP Only" },
  { key: "hgab_only", label: "HGAB Only" },
  { key: "senate_only", label: "Senate Only" },
  { key: "nep_hgab", label: "NEP + HGAB" },
  { key: "nep_senate", label: "NEP + Senate" },
  { key: "hgab_senate", label: "HGAB + SENATE" },
  { key: "nep_hgab_senate", label: "NEP + HGAB + SENATE" },
  { key: "all_nep", label: "All NEP funded" },
  { key: "all_hgab", label: "All HGAB funded" },
  { key: "all_senate", label: "All SENATE funded" },
];

export function matchesAllocFilter(f: FacilityRecord, key: string): boolean {
  if (!key || key === "all") return true;
  const nep = (f.budget.nep_total || 0) > 0;
  const gab = (f.budget.gab_total || 0) > 0;
  const sen = (f.budget.senate_total || 0) > 0;

  switch (key) {
    case "nep_only":
      return nep && !gab && !sen;
    case "hgab_only":
      return !nep && gab && !sen;
    case "senate_only":
      return !nep && !gab && sen;
    case "nep_hgab":
      return nep && gab && !sen;
    case "nep_senate":
      return nep && !gab && sen;
    case "hgab_senate":
      return !nep && gab && sen;
    case "nep_hgab_senate":
      return nep && gab && sen;
    case "all_nep":
      return nep;
    case "all_hgab":
      return gab;
    case "all_senate":
      return sen;
    default:
      return true;
  }
}

export function countAllocOptions(facilities: FacilityRecord[]): Record<AllocFilterKey, number> {
  const counts: Record<AllocFilterKey, number> = {
    all: facilities.length,
    nep_only: 0,
    hgab_only: 0,
    senate_only: 0,
    nep_hgab: 0,
    nep_senate: 0,
    hgab_senate: 0,
    nep_hgab_senate: 0,
    all_nep: 0,
    all_hgab: 0,
    all_senate: 0,
  };
  for (const f of facilities) {
    const nep = (f.budget.nep_total || 0) > 0;
    const gab = (f.budget.gab_total || 0) > 0;
    const sen = (f.budget.senate_total || 0) > 0;
    if (nep) counts.all_nep += 1;
    if (gab) counts.all_hgab += 1;
    if (sen) counts.all_senate += 1;
    if (nep && gab && sen) counts.nep_hgab_senate += 1;
    else if (nep && gab && !sen) counts.nep_hgab += 1;
    else if (nep && !gab && sen) counts.nep_senate += 1;
    else if (!nep && gab && sen) counts.hgab_senate += 1;
    else if (nep && !gab && !sen) counts.nep_only += 1;
    else if (!nep && gab && !sen) counts.hgab_only += 1;
    else if (!nep && !gab && sen) counts.senate_only += 1;
  }
  return counts;
}
