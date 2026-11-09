// Pure rules for the Google Calendar pull (google-sync/calendar.ts), kept free
// of Deno and the network so tools/calendar-pull.test.ts can import them.

/**
 * The calendar a pulled row should record. A Google event id is the same on
 * every calendar the event shows on, so an event CLOZR made on its own
 * calendar comes back again from the member's primary when they (or a
 * teammate) are a guest. That copy must not move the row: re-stamped with the
 * primary, the push would treat CLOZR's own event as a mirror and stop
 * writing to it. A row already on a CLOZR calendar stays there, and a row
 * read from a mirror feed keeps the calendar it already has.
 */
export function pulledCalendarId(existing: string | null, reading: string, readingWritable: boolean, writable: ReadonlySet<string>): string {
  if (!existing || existing === reading) return reading;
  return writable.has(existing) || !readingWritable ? existing : reading;
}
