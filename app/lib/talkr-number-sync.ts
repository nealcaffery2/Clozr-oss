// Lines CLOZR already tracks but Talkr has not imported yet — usually
// "Add existing" or a Podio migration wrote rep_phone_numbers only.

import { areaCity, talkr } from './talkr';
import type { BookLine, NumberBook } from './number-book';
import { e164 } from './number-book';

export type OrphanImportResult = { imported: string[]; skipped: string[]; errors: string[] };

/**
 * For each line with no Talkr row, import from the carrier inventory when the
 * number is there. `assign` returns the Talkr user id to assign (or null).
 */
export async function importOrphanLinesToTalkr(
  book: NumberBook,
  assign: (line: BookLine) => Promise<string | null>,
): Promise<OrphanImportResult> {
  const orphans = [...book.people.flatMap((p) => p.lines), ...book.company].filter((l) => !l.talkr);
  if (!orphans.length) return { imported: [], skipped: [], errors: [] };

  let carrier: Map<string, true>;
  try {
    const r = await talkr.carrierNumbers();
    carrier = new Map(r.numbers.map((c) => [e164(c.phone_e164), true]).filter(([p]) => p) as [string, true][]);
  } catch (err) {
    return { imported: [], skipped: orphans.map((l) => l.phone), errors: [err instanceof Error ? err.message : String(err)] };
  }

  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const line of orphans) {
    if (!carrier.has(line.phone)) {
      skipped.push(line.phone);
      continue;
    }
    try {
      const assigned = await assign(line);
      await talkr.importNumber({
        phone_e164: line.phone,
        assigned_user_id: assigned,
        label: line.label?.trim() || areaCity(line.phone) || null,
      });
      imported.push(line.phone);
    } catch (err) {
      errors.push(`${line.phone}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { imported, skipped, errors };
}
