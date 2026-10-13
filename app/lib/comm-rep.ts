// Who handled a call, text or email, for every report that credits one.
//
// The person who made or took it, not whose seller it was: a dispo rep calling
// buyers has no seller on the row, and a rep calling a teammate's lead made
// the call themselves. In order:
//   1. communications.rep_id: Talkr's user, or the line's owner the database
//      filled in (migrations 153, 190);
//   2. the owner of the team line it used (outbound: the number it came from;
//      inbound: the number it reached), for rows read before 190 recredited;
//   3. the rep the seller is assigned to, the old rule, for an email or a call
//      on a line nobody owns.
// What none of those reaches is reported under its line's name ("Texas line")
// when it used one, else as Unassigned.

export type LineRow = { phone10: string; user_id: string | null; label: string };
export type CommLike = {
  rep_id?: string | null; seller_id: number | null; direction: string | null;
  from_phone?: string | null; to_phone?: string | null;
};

export const phone10 = (p: string | null | undefined) => String(p ?? '').replace(/\D/g, '').slice(-10);

/** The team line a message used, by the number on our side of it. */
export function lineOf(c: CommLike, lines: Map<string, LineRow>): LineRow | undefined {
  const ours = phone10(c.direction === 'inbound' ? c.to_phone : c.from_phone);
  return ours ? lines.get(ours) : undefined;
}

export function lineBook(rows: LineRow[] | undefined): Map<string, LineRow> {
  return new Map((rows ?? []).map((l) => [l.phone10, l] as const));
}

/**
 * The teammate credited with a message, or null. `sellerRep` is the seller's
 * assigned rep; `isMember` drops ids that are no longer on the team, so a
 * former rep's line falls through to the seller's rep instead of a ghost.
 */
export function commRep(
  c: CommLike, lines: Map<string, LineRow>, sellerRep: (id: number | null) => string | null,
  isMember: (id: string | null | undefined) => boolean = (id) => !!id,
): string | null {
  if (isMember(c.rep_id)) return c.rep_id!;
  const owner = lineOf(c, lines)?.user_id;
  if (isMember(owner)) return owner!;
  const seller = sellerRep(c.seller_id);
  return isMember(seller) ? seller : null;
}

/** Where an uncredited message goes in a "by rep" table: its line's name, else null (Unassigned). */
export function commLineName(c: CommLike, lines: Map<string, LineRow>): string | null {
  const l = lineOf(c, lines);
  return l ? `${l.label} line` : null;
}

/**
 * The teammate a line's name points at: its first word is exactly one
 * teammate's first name ("Diego Main" → Diego). Null when none or several
 * match, so a guess is only ever offered, never made for two people.
 */
export function suggestLineOwner<T extends { user_id: string; full_name: string | null }>(label: string, team: T[]): T | null {
  const first = (s: string | null | undefined) => String(s ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const want = first(label);
  if (!want) return null;
  const hits = team.filter((m) => first(m.full_name) === want);
  return hits.length === 1 ? hits[0] : null;
}
