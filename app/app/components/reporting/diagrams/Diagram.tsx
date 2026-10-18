'use client';

// The frame every reporting diagram sits in: title, one-line caption, a
// Download SVG action, a measured width so the SVG lays out at 1:1 and text
// never shrinks (a narrow card scrolls sideways instead), a hover/focus tooltip
// with the exact numbers, a legend strip where every colour gets a word, and
// the empty state. Colours come from diagrams.css (--dia-*), which switches to
// the monochrome blueprint under [data-theme="dark"].

import React from 'react';
import { Download } from 'lucide-react';
import './diagrams.css';

export type Tip = { show: (el: Element, text: string) => void; hide: () => void };

/** Hover and focus handlers for one node; `text` is the tooltip, newline-separated. */
export const tipProps = (tip: Tip, text: string, label = text.replace(/\n/g, ', ')) => ({
  tabIndex: 0,
  role: 'img' as const,
  'aria-label': label,
  className: 'dia-node',
  onMouseEnter: (e: React.MouseEvent) => tip.show(e.currentTarget, text),
  onMouseLeave: tip.hide,
  onFocus: (e: React.FocusEvent) => tip.show(e.currentTarget, text),
  onBlur: tip.hide,
});

export const num = (n: number) => Math.round(n).toLocaleString('en-US');
export const usd = (n: number) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) + '%' : '—');
/** Rough text width at a size, for sizing boxes around labels (0.58em per character in Inter). */
export const tw = (s: string, size: number) => s.length * size * 0.58;
export const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

export const CAT = ['var(--dia-cat-1)', 'var(--dia-cat-2)', 'var(--dia-cat-3)', 'var(--dia-cat-4)', 'var(--dia-cat-5)', 'var(--dia-cat-6)', 'var(--dia-cat-7)', 'var(--dia-cat-8)'];
export const cat = (i: number, name?: string) => (name === 'Other' || name === 'Unknown' || name === 'Unassigned' || i >= CAT.length ? 'var(--dia-cat-other)' : CAT[i]);

export function Diagram({ title, caption, empty, minWidth, legend, children, height }: {
  title: string; caption: string;
  /** When set, the empty state shows instead of the SVG. */
  empty?: string | null;
  /** The narrowest layout the diagram can draw; a narrower card scrolls. */
  minWidth: number;
  legend?: { color: string; label: string }[];
  /** Draws the SVG body for a measured width. */
  children: (w: number, tip: Tip, ids: { dots: string }) => React.ReactNode;
  height: number;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [w, setW] = React.useState(0);
  const [tip, setTip] = React.useState<{ x: number; y: number; text: string } | null>(null);
  const uid = React.useId().replace(/:/g, '');
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const api = React.useMemo<Tip>(() => ({
    show: (el, text) => {
      const host = el.closest<HTMLElement>('.dia-scroll');
      if (!host) return;
      const a = el.getBoundingClientRect(), b = host.getBoundingClientRect();
      setTip({ x: a.left - b.left + a.width / 2 + host.scrollLeft, y: a.top - b.top, text });
    },
    hide: () => setTip(null),
  }), []);
  const download = () => {
    const svg = svgRef.current;
    if (!svg) return;
    // Standalone SVG files cannot read the page's CSS variables, so bake the computed colours and fonts in.
    const copy = svg.cloneNode(true) as SVGSVGElement;
    const src = svg.querySelectorAll<SVGElement>('*'), dst = copy.querySelectorAll<SVGElement>('*');
    // Every element gets its computed paint, since classes (ribbon opacity, dark-mode highlights, hidden counts) go with the class attribute.
    src.forEach((s, i) => {
      const cs = getComputedStyle(s), d = dst[i];
      for (const p of ['fill', 'stroke', 'opacity', 'font-family', 'display'] as const) d.setAttribute(p, cs.getPropertyValue(p));
      d.removeAttribute('class'); d.removeAttribute('tabindex');
    });
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', String(svg.clientWidth)); copy.setAttribute('height', String(svg.clientHeight));
    copy.style.fontFamily = getComputedStyle(svg).fontFamily;
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.svg' });
    a.click();
    URL.revokeObjectURL(url);
  };
  const width = Math.max(minWidth, w);
  return (
    <div className="dia" style={{ border: '1px solid var(--dia-rule)', borderRadius: 12, minWidth: 0 }}>
      <div className="dia-head">
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          <p>{caption}</p>
        </div>
        {empty ? null : <button type="button" className="dia-dl" onClick={download} aria-label={`Download ${title} as SVG`}><Download aria-hidden="true" strokeWidth={2} />SVG</button>}
      </div>
      {empty ? <div className="dia-empty">{empty}</div> : (
        <div ref={box} className="dia-scroll" style={{ position: 'relative' }}>
          <svg ref={svgRef} className="dia-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${uid}-t ${uid}-d`}>
            <title id={`${uid}-t`}>{title}</title>
            <desc id={`${uid}-d`}>{caption}</desc>
            <defs>
              <pattern id={`${uid}-dots`} width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--dia-dot)" /></pattern>
            </defs>
            <rect width={width} height={height} fill="var(--dia-paper)" />
            <rect width={width} height={height} fill={`url(#${uid}-dots)`} />
            {w ? children(width, api, { dots: `${uid}-dots` }) : null}
          </svg>
          {tip ? <div className="dia-tip" role="status" style={{ left: Math.min(Math.max(8, tip.x - 90), Math.max(8, width - 190)), top: Math.max(4, tip.y - 8), transform: 'translateY(-100%)' }}>{tip.text}</div> : null}
        </div>
      )}
      {!empty && legend?.length ? (
        <div className="dia-legend" aria-label="Legend">
          {legend.map((l) => <span key={l.label}><i style={{ background: l.color }} aria-hidden="true" />{l.label}</span>)}
        </div>
      ) : null}
    </div>
  );
}
