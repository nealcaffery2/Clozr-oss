// The assistants' answers as formatted text: lib/md.ts reads the markdown,
// this renders it as React elements. Nothing is set as HTML, so model text
// cannot inject markup; links open in a new tab and only http(s)/mailto pass.
'use client';

import React from 'react';
import { parseMarkdown, type Block, type Inline } from '@/lib/md';

function inline(nodes: Inline[], key = 'i'): React.ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text': {
        // A line break inside a paragraph stays a line break.
        const parts = n.v.split('\n');
        return <React.Fragment key={k}>{parts.map((p, j) => (j ? [<br key={j} />, p] : p))}</React.Fragment>;
      }
      case 'strong': return <strong key={k} style={{ fontWeight: 600 }}>{inline(n.c, k)}</strong>;
      case 'em': return <em key={k}>{inline(n.c, k)}</em>;
      case 'code': return <code key={k} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.92em', background: '#f4f4f5', borderRadius: 4, padding: '1px 4px' }}>{n.v}</code>;
      case 'link': return <a key={k} href={n.href} target="_blank" rel="noopener noreferrer" style={{ color: '#0369A1', textDecoration: 'underline' }}>{inline(n.c, k)}</a>;
    }
  });
}

const HEADING_SIZE = { 1: '1.15em', 2: '1.07em', 3: '1em' } as const;

function block(b: Block, i: number, first: boolean): React.ReactNode {
  const gap = first ? 0 : '0.6em';
  switch (b.t) {
    case 'p': return <p key={i} style={{ margin: `${gap} 0 0` }}>{inline(b.c)}</p>;
    case 'h': return <p key={i} role="heading" aria-level={b.level + 2} style={{ margin: `${first ? 0 : '0.85em'} 0 0`, fontWeight: 600, fontSize: HEADING_SIZE[b.level] }}>{inline(b.c)}</p>;
    case 'ul': return (
      <ul key={i} style={{ margin: `${gap} 0 0`, paddingLeft: '1.25em', listStyle: 'disc' }}>
        {b.items.map((it, j) => <li key={j} style={{ marginTop: j ? '0.25em' : 0 }}>{inline(it)}</li>)}
      </ul>
    );
    case 'ol': return (
      <ol key={i} start={b.start} style={{ margin: `${gap} 0 0`, paddingLeft: '1.45em', listStyle: 'decimal' }}>
        {b.items.map((it, j) => <li key={j} style={{ marginTop: j ? '0.25em' : 0 }}>{inline(it)}</li>)}
      </ol>
    );
  }
}

/** Markdown text as formatted React elements. Takes the surrounding font, size and colour. */
export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text ?? '');
  return <>{blocks.map((b, i) => block(b, i, i === 0))}</>;
}
