// How a wholesaler or national partner is doing with us: deals they brought,
// how often we got an offer accepted, how many were declined, how many closed,
// and the fees those closes made. National sources do not get the weekly
// "any other deals?" email.

export type SourceEvent = {
  stage: string;
  /** We put a number in front of them. */
  offered: boolean;
  accepted: boolean;
  declined: boolean;
  closed: boolean;
  /** Fee booked on a close. Ignored unless `closed`. */
  fee: number;
};

export type SourceScorecard = {
  brought: number;
  offered: number;
  accepted: number;
  /** Accepted ÷ offered, as a whole percent. Null when we have not offered. */
  acceptancePct: number | null;
  declined: number;
  closed: number;
  fees: number;
};

const DECLINED = /declin|terminat/i;
const CLOSED = /^closed$/i;
const ACCEPTED = /offer accepted|under contract|ready to market|buyer under contract|in escrow|^closed$/i;

/** Fold a stage name (seller stage or deal stage) into the scorecard flags. */
export function flagsForStage(stage: string, fee = 0, offered = false): SourceEvent {
  const closed = CLOSED.test(stage.trim());
  const declined = !closed && DECLINED.test(stage);
  const accepted = !declined && (closed || ACCEPTED.test(stage));
  return { stage, offered: offered || accepted || declined, accepted, declined, closed, fee: closed ? fee : 0 };
}

export function sourceScorecard(events: SourceEvent[]): SourceScorecard {
  const brought = events.length;
  const offered = events.filter((e) => e.offered).length;
  const accepted = events.filter((e) => e.accepted).length;
  const declined = events.filter((e) => e.declined).length;
  const closed = events.filter((e) => e.closed).length;
  const fees = events.reduce((sum, e) => sum + (e.closed ? e.fee : 0), 0);
  return {
    brought, offered, accepted, declined, closed, fees,
    acceptancePct: offered ? Math.round((accepted / offered) * 100) : null,
  };
}

export function formatSourceScore(card: SourceScorecard): string {
  if (!card.brought) return 'No deals brought yet';
  const pct = card.acceptancePct == null ? '—' : card.acceptancePct + '%';
  const fees = '$' + Math.round(card.fees).toLocaleString('en-US');
  return `${card.brought} brought · ${pct} accepted · ${card.declined} declined · ${card.closed} closed · ${fees} fees`;
}

/** Institutional / national partners. They still get a score. They do not get email follow-up. */
export function isNationalSource(input: { kind?: string | null; name?: string | null; note?: string | null; tags?: string[] | null }): boolean {
  const blob = [input.kind, input.name, input.note, ...(input.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
  return /institutional|national partner|national source|\bnational\b/.test(blob);
}

export function sourceGetsEmailFollowup(input: { kind?: string | null; name?: string | null; note?: string | null; tags?: string[] | null }): boolean {
  return !isNationalSource(input);
}

/**
 * A new submission that needs an offer belongs to whoever created that lead.
 * A CSV import stamps the same person on every row, so a batch lands on the
 * importer. An empty creator stays unassigned.
 */
export function assigneeForIncomingLead(createdBy: string | null | undefined): string | null {
  const id = (createdBy ?? '').trim();
  return id || null;
}

/** True only on the transition into Underwriting Complete, so a re-save does not ping twice. */
export function shouldPingUnderwriteComplete(previous: string | null | undefined, next: string | null | undefined): boolean {
  return (next ?? '') === 'Underwriting Complete' && (previous ?? '') !== 'Underwriting Complete';
}

const SOURCE_KINDS = /wholesaler|institutional|partner/i;

export function isDealSource(kind: string | null | undefined): boolean {
  return SOURCE_KINDS.test(kind ?? '');
}
