'use client';

// The template library: the stock reports (built for wholesaling — leads,
// deals, fees, calls, appointments, dispo) and the workspace's own saved
// templates, with categories, search, favourites and a preview.

import React, { useMemo, useState } from 'react';
import { TEMPLATES, TEMPLATE_CATEGORIES, THEMES, WIDGET_BY_KEY, type TemplateDef } from '@/lib/report-catalog';
import { DEFAULT_PAGE, uid, type Block, type ReportDef, type ReportRow } from '@/lib/report-store';
import { ACCENT, INK, LINE, MUTED, SOFT, btn, field } from './ui';

const FAV_KEY = 'clozr.report.favs';

function readFavs(): string[] {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]') as string[]; } catch { return []; }
}

/** A stock template as a report definition, every block a fresh copy of its catalog spec. */
export function defFromTemplate(t: TemplateDef): ReportDef {
  const pages = t.pages.map((p) => ({
    id: uid(), title: p.title,
    blocks: p.blocks.flatMap((b): Block[] => {
      const w = WIDGET_BY_KEY[b.key];
      if (!w) return [];
      const chart = b.chart ?? w.chart;
      const width: 1 | 2 = b.w ?? (chart === 'table' || chart === 'line' || chart === 'column' || chart === 'funnel' ? 2 : 1);
      if (w.formula) return [{ id: uid(), kind: 'metric', key: w.key, chart: 'number', title: w.label, formula: structuredClone(w.formula), format: w.format, polarity: 'up', w: width }];
      return [{ id: uid(), kind: 'widget', key: w.key, chart, title: w.label, spec: structuredClone(w.spec), w: width }];
    }),
  }));
  return { pages, theme: THEMES[0], page: { ...DEFAULT_PAGE }, datePreset: 'Last 30 days', custom: null, comparison: 'previous' };
}

type Card = { id: string; name: string; description: string; categories: string[]; color: string; icon: string; pages: { title: string; blocks: number }[]; mine?: ReportRow; stock?: TemplateDef };

export function TemplateLibrary({ mine, onChoose, onClose }: { mine: ReportRow[]; onChoose: (def: ReportDef, name: string, from: string) => void; onClose: () => void }) {
  const [nav, setNav] = useState<'all' | 'mine' | 'favs'>('all');
  const [cats, setCats] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'default' | 'popular'>('default');
  const [grid, setGrid] = useState(true);
  const [favs, setFavs] = useState<string[]>(() => readFavs());
  const [preview, setPreview] = useState<Card | null>(null);

  const cards: Card[] = useMemo(() => [
    ...TEMPLATES.map((t): Card => ({ id: 'stock:' + t.id, name: t.name, description: t.description, categories: t.categories, color: t.color, icon: t.icon, pages: t.pages.map((p) => ({ title: p.title, blocks: p.blocks.length })), stock: t })),
    ...mine.map((r): Card => ({ id: 'mine:' + r.id, name: r.name, description: `Saved from a report on ${new Date(r.updated_at).toLocaleDateString('en-US')}`, categories: ['My templates'], color: '#52525b', icon: r.name.slice(0, 1).toUpperCase(), pages: r.definition.pages.map((p) => ({ title: p.title, blocks: p.blocks.length })), mine: r })),
  ], [mine]);

  const shown = cards
    .filter((c) => (nav === 'mine' ? !!c.mine : nav === 'favs' ? favs.includes(c.id) : true))
    .filter((c) => !cats.length || c.categories.some((x) => cats.includes(x)))
    .filter((c) => !q || (c.name + ' ' + c.description).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === 'popular' ? b.pages.reduce((n, p) => n + p.blocks, 0) - a.pages.reduce((n, p) => n + p.blocks, 0) : 0));

  const toggleFav = (id: string) => {
    const next = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
    setFavs(next);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };
  const choose = (c: Card) => {
    if (c.stock) onChoose(defFromTemplate(c.stock), c.name, 'template');
    else if (c.mine) onChoose(structuredClone(c.mine.definition), c.mine.name.replace(/ \(template\)$/i, ''), 'template');
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Template library" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(24,24,27,.45)', display: 'grid', placeItems: 'center', padding: '16px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '14px', width: '100%', maxWidth: '1040px', height: 'min(92vh, 720px)', display: 'flex', overflow: 'hidden' }}>
        <aside style={{ width: '220px', flex: 'none', borderRight: `1px solid ${LINE}`, padding: '14px 12px', overflow: 'auto' }}>
          {([['all', 'All templates'], ['mine', 'My templates'], ['favs', 'Favorites']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setNav(k)} style={{ display: 'block', width: '100%', textAlign: 'left', height: '32px', padding: '0 10px', border: 0, borderRadius: '8px', background: nav === k ? '#E7F8F1' : 'transparent', color: nav === k ? ACCENT : INK, fontSize: '13px', fontWeight: nav === k ? 600 : 500, cursor: 'pointer' }}>{l}</button>
          ))}
          <div style={{ fontSize: '11px', color: MUTED, fontWeight: 600, padding: '14px 10px 6px' }}>Browse categories</div>
          {TEMPLATE_CATEGORIES.map((c) => {
            const n = cards.filter((x) => x.categories.includes(c)).length;
            return (
              <label key={c} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 10px', fontSize: '12.5px', cursor: 'pointer' }}>
                <input type="checkbox" checked={cats.includes(c)} onChange={() => setCats(cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c])} style={{ accentColor: ACCENT }} />
                <span style={{ flex: 1 }}>{c}</span><span style={{ color: MUTED, fontSize: '11px' }}>{n}</span>
              </label>
            );
          })}
        </aside>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', borderBottom: `1px solid ${SOFT}` }}>
            <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, flex: 1 }}>Template library</h2>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" aria-label="Search templates" style={{ ...field, width: '200px' }} />
            <select value={sort} onChange={(e) => setSort(e.target.value as 'default' | 'popular')} aria-label="Sort" style={{ ...field, width: '130px' }}><option value="default">Default</option><option value="popular">Most complete</option></select>
            <button type="button" onClick={() => setGrid(!grid)} aria-label={grid ? 'List view' : 'Grid view'} style={btn.icon}>{grid ? '☰' : '▦'}</button>
            <button type="button" onClick={onClose} aria-label="Close" style={{ ...btn.icon, border: 0, fontSize: '18px' }}>×</button>
          </div>

          {preview ? (
            <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
              <button type="button" onClick={() => setPreview(null)} style={btn.ghost}>← All templates</button>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: '16px', marginTop: '14px' }}>
                <div style={{ border: `1px solid ${LINE}`, borderRadius: '12px', padding: '20px', background: '#fafafa' }}>
                  <div style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '10px', padding: '18px' }}>
                    <div style={{ fontSize: '18px', fontWeight: 700 }}>{preview.name}</div>
                    <div style={{ fontSize: '12px', color: MUTED, marginTop: '4px' }}>Cover page · report date range</div>
                  </div>
                  {preview.pages.map((p) => (
                    <div key={p.title} style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '10px', padding: '14px 18px', marginTop: '10px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600 }}>{p.title}</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginTop: '10px' }}>
                        {Array.from({ length: p.blocks }).map((_, i) => <div key={i} style={{ height: '34px', borderRadius: '6px', background: SOFT }} />)}
                      </div>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: '16px', fontWeight: 700 }}>{preview.name}</div>
                  <p style={{ fontSize: '12.5px', color: '#52525b', lineHeight: 1.55, margin: '6px 0 10px' }}>{preview.description}</p>
                  <div style={{ fontSize: '12px', color: MUTED }}>{preview.pages.length} page{preview.pages.length === 1 ? '' : 's'} · {preview.pages.reduce((n, p) => n + p.blocks, 0)} widgets</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', margin: '10px 0 14px' }}>{preview.categories.map((c) => <span key={c} style={{ fontSize: '11px', background: SOFT, borderRadius: '999px', padding: '2px 8px', color: '#52525b' }}>{c}</span>)}</div>
                  <button type="button" onClick={() => choose(preview)} style={{ ...btn.accent, width: '100%' }}>Choose template</button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
              {!shown.length ? <p style={{ fontSize: '12.5px', color: MUTED }}>{nav === 'mine' ? 'Save any report as a template (⋯ → Save as template) and it shows up here.' : 'No template matches.'}</p> : null}
              <div style={{ display: grid ? 'grid' : 'flex', flexDirection: 'column', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' }}>
                {shown.map((c) => (
                  <div key={c.id} style={{ border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'hidden', display: grid ? 'block' : 'grid', gridTemplateColumns: grid ? undefined : '120px 1fr auto', alignItems: 'center' }}>
                    <div style={{ height: grid ? '84px' : '100%', minHeight: '64px', background: c.color, display: 'grid', placeItems: 'center', color: '#fff', font: '700 26px system-ui, sans-serif' }}>{c.icon}</div>
                    <div style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: INK, flex: 1 }}>{c.name}</div>
                        <button type="button" onClick={() => toggleFav(c.id)} aria-label="Favorite" aria-pressed={favs.includes(c.id)} style={{ border: 0, background: 'none', cursor: 'pointer', color: favs.includes(c.id) ? '#e34948' : '#a1a1aa', fontSize: '14px' }}>{favs.includes(c.id) ? '♥' : '♡'}</button>
                      </div>
                      <p style={{ margin: '4px 0 8px', fontSize: '11.5px', color: MUTED, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.description}</p>
                      <div style={{ fontSize: '11px', color: MUTED }}>{c.pages.length} page{c.pages.length === 1 ? '' : 's'} · {c.pages.reduce((n, p) => n + p.blocks, 0)} widgets</div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', padding: grid ? '0 12px 12px' : '0 12px' }}>
                      <button type="button" onClick={() => setPreview(c)} style={{ ...btn.ghost, flex: grid ? 1 : undefined }}>Preview</button>
                      <button type="button" onClick={() => choose(c)} style={{ ...btn.primary, flex: grid ? 1 : undefined }}>Choose</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
