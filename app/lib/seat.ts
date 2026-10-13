// Which seat's work is whose, by workspace role (lib/team Role). No imports:
// lib/today.ts and the edge functions' focus loader (_shared/focus.ts) share it.

/** Seats that work the acquisitions side: the unassigned new-lead pool is theirs. No role reads as acquisitions. */
export const workPool = (role?: string | null) => !role || !/^(dispositions|tc|notary)$/i.test(role);

/** Task types that are another seat's work: the TC's checklist, dispo's buyers. A seat's own type is its work. */
export const notMine = (role?: string | null): RegExp =>
  /^dispositions$/i.test(role ?? '') ? /^tc$/i : /^tc$/i.test(role ?? '') ? /^dispo$/i : /^(tc|dispo)$/i;
