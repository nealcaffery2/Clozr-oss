'use client';

// Rebuild counts for the expensive memos in useClozr (graph, V and the slices
// V is built from), readable in the console as `window.__clozrPerf`: how many
// times each was rebuilt since load, the time they took and the longest one.
// Cheap enough to leave on: a performance.now() per lap and an effect that
// runs only when a memo's identity changed.
//
// Two kinds of number. `V` and `graph` (usePerfTrack) run from the render
// that rebuilt the memo to the effect after commit, so they include every
// screen's render: the cost a keystroke is felt as. `V.memo`, `graph.memo`
// and the rest (perfLapStart / perfLap / perfLapEnd) time the memo bodies
// alone, `V/<segment>` being the stretches of V between two laps.

import { useEffect } from 'react';

type Tally = { n: number; ms: number; max: number };
const tallies: Record<string, Tally> = {};
if (typeof window !== 'undefined') (window as unknown as { __clozrPerf: typeof tallies }).__clozrPerf = tallies;

export function perfNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function tally(name: string, ms: number) {
  const t = tallies[name] ?? (tallies[name] = { n: 0, ms: 0, max: 0 });
  t.n += 1;
  t.ms += ms;
  if (ms > t.max) t.max = ms;
}

let seriesName = '';
let seriesAt = 0;
let lapAt = 0;

/** Start timing a memo body named `name`; perfLap splits it, perfLapEnd closes it as `<name>.memo`. */
export function perfLapStart(name: string) {
  seriesName = name;
  seriesAt = lapAt = perfNow();
}

/** Record the time since the previous lap (or the start) as `<series>/<name>`. */
export function perfLap(name: string) {
  const now = perfNow();
  tally(seriesName + '/' + name, now - lapAt);
  lapAt = now;
}

export function perfLapEnd() {
  tally(seriesName + '.memo', perfNow() - seriesAt);
}

/**
 * Count a rebuild of `value` (a new identity since the last render) and the
 * time since `startedAt`. Recorded after the render, in an effect keyed on the
 * value: the React Compiler rules do not allow a ref read or a module write
 * during render, and the number is the same either way.
 */
export function usePerfTrack(name: string, value: unknown, startedAt: number) {
  useEffect(() => {
    tally(name, perfNow() - startedAt);
    // startedAt is this render's clock; the effect runs once per new value, which is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, value]);
}
