/** The photos in an iVueit survey submission (GET /api/v1/surveysubmission/{id}). Pure, so tools/ivueit.test.ts runs it. */

type Any = Record<string, unknown>;

export type VuePhoto = { id: string; url: string; caption: string; mime: string };

/** Every photo in a submission, in step order, each once. */
export function submissionPhotos(sub: Any): VuePhoto[] {
  const steps = Array.isArray(sub.steps) ? sub.steps as Any[] : [];
  const seen = new Set<string>();
  const out: VuePhoto[] = [];
  const sorted = [...steps].sort((a, b) => Number(a.StepNumber ?? a.stepNumber ?? 0) - Number(b.StepNumber ?? b.stepNumber ?? 0));
  for (const s of sorted) {
    const caption = String(s.Description ?? s.description ?? '').trim();
    const photos = Array.isArray(s.Photos) ? s.Photos as Any[] : Array.isArray(s.photos) ? s.photos as Any[] : [];
    for (const p of photos) {
      const info = (p.info ?? {}) as Any;
      const url = String(p.url ?? '');
      const id = String(info.id ?? url);
      if (!url || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, url, caption, mime: String(info.mimeType ?? 'image/jpeg') });
    }
  }
  return out;
}

/** The webhooks iVueit offers (one active per type per company), all pointed at ivueit-webhook with `e=<type>`. */
export const IVUEIT_HOOK_TYPES = ['VueCompleted', 'VueCanceled', 'VueEscalated'] as const;
export type IvueitHookType = typeof IVUEIT_HOOK_TYPES[number];
/** Which webhook fired; a URL from before the type was added (no `e`) is VueCompleted, and any other value is null. */
export const hookTypeOf = (v: string | null | undefined): IvueitHookType | null =>
  v == null || v === '' ? 'VueCompleted'
    : (IVUEIT_HOOK_TYPES as readonly string[]).includes(v) ? v as IvueitHookType : null;
