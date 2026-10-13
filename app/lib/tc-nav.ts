// Arrow movement on a transaction file.
// Left and right walk the deals in the open stage. Up and down move to the
// previous or next stage and land on a deal there, so the same left and right
// keys then walk that stage.

export type TcColumn = { stage: string; ids: string[] };

export type TcPlace = {
  stage: string;
  /** 0-based index of this deal inside its stage. */
  index: number;
  count: number;
  stageIndex: number;
  stageCount: number;
  canPrevDeal: boolean;
  canNextDeal: boolean;
  canPrevStage: boolean;
  canNextStage: boolean;
};

const filled = (columns: TcColumn[]) => columns.filter((c) => c.ids.length > 0);

export function tcPlace(columns: TcColumn[], id: string): TcPlace | null {
  const stages = filled(columns);
  const stageIndex = stages.findIndex((c) => c.ids.includes(id));
  if (stageIndex < 0) return null;
  const ids = stages[stageIndex].ids;
  const index = ids.indexOf(id);
  return {
    stage: stages[stageIndex].stage,
    index,
    count: ids.length,
    stageIndex,
    stageCount: stages.length,
    canPrevDeal: index > 0,
    canNextDeal: index < ids.length - 1,
    canPrevStage: stageIndex > 0,
    canNextStage: stageIndex < stages.length - 1,
  };
}

/** A deal that is over: its TC file is history, not work. */
const DONE_STAGES = new Set(['Closed', 'Terminated', 'Realtor Referral']);

/**
 * The transaction files still being worked, soonest close first (no close
 * date last). A file whose deal is closed, terminated or archived is done.
 * A file whose deal this role cannot read stays in: it may well be open.
 */
export function openTcFiles<T extends { dealId: string; closingIso?: string | null }>(
  files: T[], dealOf: (dealId: string) => { stage?: string | null; archived?: boolean } | undefined,
): T[] {
  const at = (t: T) => (t.closingIso ? Date.parse(t.closingIso.slice(0, 10) + 'T12:00:00') : NaN);
  return files
    .filter((t) => { const d = t.dealId ? dealOf(t.dealId) : undefined; return !d || (!d.archived && !DONE_STAGES.has(d.stage ?? '')); })
    .sort((a, b) => {
      const x = at(a), y = at(b);
      if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
      return x - y;
    });
}

/** The person id to open, or null at the end of the row or the column. */
export function stepTc(columns: TcColumn[], id: string, dir: 'deal' | 'stage', delta: -1 | 1): string | null {
  const place = tcPlace(columns, id);
  if (!place) return null;
  const stages = filled(columns);
  if (dir === 'deal') {
    const ids = stages[place.stageIndex].ids;
    const next = place.index + delta;
    if (next < 0 || next >= ids.length) return null;
    return ids[next];
  }
  const stageIndex = place.stageIndex + delta;
  if (stageIndex < 0 || stageIndex >= stages.length) return null;
  const ids = stages[stageIndex].ids;
  return ids[Math.min(place.index, ids.length - 1)];
}
