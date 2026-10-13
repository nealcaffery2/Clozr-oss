// The browser half of the call player's AI: chapters and "ask the call"
// search from the call-sections edge function, with the plain fallbacks in
// lib/call-media.ts when the function or its ANTHROPIC_API_KEY is missing.
import { supabase } from './supabase';
import { keywordSections, textSearch, type CallSection, type CallSegment } from './call-media';

async function invoke<T>(body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('call-sections', { body });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  return { ok: true, data: data as T };
}

export type SectionsResult = { sections: CallSection[]; source: 'ai' | 'keywords'; note: string | null };

/** AI chapters (stored once per call), else keyword chapters with the reason. */
export async function loadSections(communicationId: number | null, segments: CallSegment[]): Promise<SectionsResult> {
  if (segments.length < 2) return { sections: [], source: 'keywords', note: null };
  if (communicationId !== null) {
    const r = await invoke<{ sections?: CallSection[] }>({ communication_id: communicationId, action: 'sections' });
    if (r.ok && r.data.sections?.length) return { sections: r.data.sections, source: 'ai', note: null };
    return { sections: keywordSections(segments), source: 'keywords', note: r.ok ? 'AI sections came back empty.' : r.message };
  }
  return { sections: keywordSections(segments), source: 'keywords', note: 'This call is not on a record yet, so its sections come from keywords.' };
}

export type SearchHit = { index: number; why: string | null };

/** "Where did they mention the roof?" as segment hits, AI first, plain text when AI is unavailable. */
export async function searchCall(communicationId: number | null, segments: CallSegment[], query: string): Promise<{ hits: SearchHit[]; source: 'ai' | 'text'; note: string | null }> {
  const q = query.trim();
  if (!q) return { hits: [], source: 'text', note: null };
  if (communicationId !== null) {
    const r = await invoke<{ matches?: SearchHit[] }>({ communication_id: communicationId, action: 'search', query: q });
    if (r.ok && Array.isArray(r.data.matches)) {
      const hits = r.data.matches.filter((m) => m.index >= 0 && m.index < segments.length);
      if (hits.length) return { hits, source: 'ai', note: null };
      const text = textSearch(segments, q).map((index) => ({ index, why: null }));
      return { hits: text, source: text.length ? 'text' : 'ai', note: null };
    }
    return { hits: textSearch(segments, q).map((index) => ({ index, why: null })), source: 'text', note: r.ok ? null : r.message };
  }
  return { hits: textSearch(segments, q).map((index) => ({ index, why: null })), source: 'text', note: null };
}
