// PLAYGROUND — Jev lead triage. Not a production screen.
//
// Isolated on purpose: nothing here is linked from Home, People, or ingest.
// Evaluating a fixture never writes a seller, a stage, or a task. Live Jev
// (TYPESAFE_API_KEY) is opt-in behind a signed-in edge-function call; everyone
// else uses the local stub so the wiring can be reviewed without a key.
'use client';

import React, { useMemo, useState } from 'react';
import { ClozrMark } from '@/components/ds/ClozrMark';
import {
  applyOverride,
  buildLeadTriageState,
  DISPOSITIONS,
  interpretTriage,
  jevRequestBody,
  NEXT_ACTIONS,
  playgroundFixtures,
  stubEvaluate,
  type HumanOverride,
  type JevResponse,
} from '@/lib/jev-triage';
import { evaluateLiveJev } from '@/lib/jev-triage-api';
import '../../clozr/tokens.css';

const MINT = '#0A8560';
const fixtures = playgroundFixtures();

function pct(n: number) {
  return Math.round(n * 100) + '%';
}
function friendlyJevError(message: string, status?: number) {
  if (status === 404 || /Failed to send a request to the Edge Function/i.test(message)) {
    return 'jev-triage is not on this project yet — it deploys with the other edge functions after merge to main. The stub still works.';
  }
  return message;
}
function tagColor(tag: string) {
  if (tag === 'Hot') return '#dc2626';
  if (tag === 'Skip') return '#71717a';
  if (tag === 'Nurture') return '#2563eb';
  if (tag === 'Follow-up') return '#d97706';
  return MINT;
}

export default function JevTriagePlayground() {
  const [fid, setFid] = useState(fixtures[0].id);
  const fixture = fixtures.find((f) => f.id === fid) ?? fixtures[0];
  const state = useMemo(() => buildLeadTriageState(fixture.input), [fixture]);
  const request = useMemo(() => jevRequestBody(state), [state]);

  const [live, setLive] = useState<JevResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [override, setOverride] = useState<HumanOverride>({});

  const modelRes = live ?? stubEvaluate(state);
  const modelSug = interpretTriage(state, modelRes);
  const sug = applyOverride(state, modelSug, override);

  function pick(id: string) {
    setFid(id);
    setLive(null);
    setErr(null);
    setOverride({});
  }

  async function callLive() {
    setBusy(true);
    setErr(null);
    const r = await evaluateLiveJev(state);
    setBusy(false);
    if (!r.ok) {
      setErr(friendlyJevError(r.message, r.status));
      return;
    }
    setLive(r.response);
    setOverride({});
  }

  return (
    <main style={{ background: '#fafafa', color: '#18181b', minHeight: '100dvh' }}>
      <header style={{
        position: 'sticky', top: 0, zIndex: 10, display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 20px', background: 'rgba(255,255,255,.92)', backdropFilter: 'saturate(180%) blur(12px)',
        borderBottom: '1px solid #e4e4e7',
      }}>
        <ClozrMark size={18} />
        <span style={{
          fontSize: 10.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase',
          color: '#92400e', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 999, padding: '4px 10px',
        }}>
          Playground
        </span>
        <strong style={{ fontSize: 14, letterSpacing: '-0.02em' }}>Jev lead triage</strong>
        <div style={{ flex: 1 }} />
        <a href="/demo" style={{ fontSize: 13, color: '#52525b', textDecoration: 'none' }}>Demo CRM</a>
        <a href="/app" style={{ fontSize: 13, fontWeight: 600, color: '#fff', background: '#18181b', borderRadius: 9, padding: '8px 12px', textDecoration: 'none' }}>
          Open CLOZR
        </a>
      </header>

      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '22px 20px 56px' }}>
        <p style={{ margin: '0 0 18px', fontSize: 14.5, lineHeight: 1.55, color: '#52525b', maxWidth: 760 }}>
          TypeSafe Jev decides <em>pursue / nurture / skip</em> plus urgency — not copy.
          This page sends the redacted lead state below. It never writes a seller, a stage, or a task.
          Without <code>TYPESAFE_API_KEY</code> the stub runs in the browser so the wiring is reviewable.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 280px) minmax(0, 1fr)', gap: 16 }}>
          <aside style={{ background: '#fff', border: '1px solid #e4e4e7', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: '#71717a', padding: '6px 8px 8px' }}>
              Fixtures
            </div>
            {fixtures.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => pick(f.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', border: 0, borderRadius: 8,
                  padding: '10px 10px', marginBottom: 4, cursor: 'pointer',
                  background: f.id === fid ? '#E7F8F1' : 'transparent',
                  color: '#18181b',
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 650 }}>{f.label}</div>
                <div style={{ fontSize: 12, color: '#71717a', marginTop: 2, lineHeight: 1.4 }}>{f.why}</div>
              </button>
            ))}
          </aside>

          <div>
            <section style={{ background: '#fff', border: '1px solid #e4e4e7', borderRadius: 12, padding: 18, marginBottom: 16 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
                <span style={{
                  fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase',
                  color: tagColor(sug.queueTag), background: '#fafafa', border: '1px solid #e4e4e7',
                  borderRadius: 999, padding: '4px 10px',
                }}>
                  {sug.queueTag}
                </span>
                <span style={{ fontSize: 12, color: '#71717a' }}>
                  {modelRes.stub ? 'stub (local heuristic)' : `Jev · ${modelRes.model}`}
                  {modelRes.usage.input_tokens ? ` · ${modelRes.usage.input_tokens} in` : ''}
                </span>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => { setLive(null); setErr(null); setOverride({}); }}
                  style={btn('#fff', '#18181b', '#e4e4e7')}
                >
                  Run stub
                </button>
                <button
                  type="button"
                  onClick={() => void callLive()}
                  disabled={busy}
                  style={btn(MINT, '#fff', MINT)}
                >
                  {busy ? 'Calling Jev…' : 'Call live Jev'}
                </button>
              </div>
              {err ? (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 10, padding: '10px 12px', fontSize: 13, marginBottom: 14 }}>
                  {err}
                  {/sign in/i.test(err) ? ' Sign in to CLOZR, then retry. The stub still works unsigned.' : ''}
                  {/not configured/i.test(err) ? ' Ask an admin to set TYPESAFE_API_KEY on the Supabase project.' : ''}
                </div>
              ) : null}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                <Card label="Disposition" value={sug.disposition} sub={`confidence ${pct(sug.dispositionConfidence)}`} />
                <Card label="Urgency (noul)" value={pct(sug.urgent)} sub="1.0 = act in 24h · noul has no confidence" />
                <Card label="Next action" value={sug.nextAction.replace(/_/g, ' ')} sub={`confidence ${pct(sug.nextActionConfidence)}`} />
              </div>

              <div style={{ marginTop: 14, fontSize: 13.5, color: '#52525b' }}>
                Suggested CLOZR stage (not applied): <strong style={{ color: '#18181b' }}>{sug.suggestedStage}</strong>
              </div>

              <Bars label="Disposition probabilities" probs={sug.dispositionProbabilities} />
              <Bars label="Next-action probabilities" probs={sug.nextActionProbabilities} />

              <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid #f0f0f1' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: '#71717a', marginBottom: 8 }}>
                  AM override — session only, nothing saved
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                  {DISPOSITIONS.map((d) => (
                    <Chip key={d} active={sug.disposition === d} onClick={() => setOverride((o) => ({ ...o, disposition: d }))}>{d}</Chip>
                  ))}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {NEXT_ACTIONS.map((a) => (
                    <Chip key={a} active={sug.nextAction === a} onClick={() => setOverride((o) => ({ ...o, nextAction: a }))}>
                      {a.replace(/_/g, ' ')}
                    </Chip>
                  ))}
                </div>
                {(override.disposition || override.nextAction) ? (
                  <button type="button" onClick={() => setOverride({})} style={{ ...btn('#fff', '#18181b', '#e4e4e7'), marginTop: 10 }}>
                    Clear override
                  </button>
                ) : null}
              </div>
            </section>

            <details style={{ background: '#fff', border: '1px solid #e4e4e7', borderRadius: 12, padding: 14, marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 650, fontSize: 13.5 }}>State sent to Jev (no PII)</summary>
              <pre style={pre}>{JSON.stringify(state, null, 2)}</pre>
            </details>
            <details style={{ background: '#fff', border: '1px solid #e4e4e7', borderRadius: 12, padding: 14, marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 650, fontSize: 13.5 }}>Exact System One request</summary>
              <pre style={pre}>{JSON.stringify(request, null, 2)}</pre>
            </details>
            <details style={{ background: '#fff', border: '1px solid #e4e4e7', borderRadius: 12, padding: 14 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 650, fontSize: 13.5 }}>Raw answers</summary>
              <pre style={pre}>{JSON.stringify(modelRes.answers, null, 2)}</pre>
            </details>
          </div>
        </div>
      </div>
    </main>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ background: '#fafafa', border: '1px solid #f0f0f1', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: '#71717a' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 750, letterSpacing: '-0.03em', marginTop: 4, textTransform: 'capitalize' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#71717a', marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function Bars({ label, probs }: { label: string; probs: Record<string, number> }) {
  const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: '#71717a', marginBottom: 8 }}>{label}</div>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 48px', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 12.5, color: '#52525b' }}>{k.replace(/_/g, ' ')}</span>
          <span style={{ display: 'block', height: 8, background: '#f4f4f5', borderRadius: 99, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: pct(v), background: MINT }} />
          </span>
          <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: '#18181b', textAlign: 'right' }}>{pct(v)}</span>
        </div>
      ))}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 32, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontSize: 13, fontWeight: 600,
        border: `1px solid ${active ? MINT : '#e4e4e7'}`,
        background: active ? MINT : '#fff',
        color: active ? '#fff' : '#18181b',
      }}
    >
      {children}
    </button>
  );
}

const pre: React.CSSProperties = {
  margin: '12px 0 0', fontSize: 12, lineHeight: 1.45, background: '#fafafa', border: '1px solid #f0f0f1',
  borderRadius: 8, padding: 12, overflow: 'auto', maxHeight: 360,
};

function btn(bg: string, color: string, border: string): React.CSSProperties {
  return {
    height: 34, padding: '0 12px', borderRadius: 9, border: `1px solid ${border}`, background: bg, color,
    fontWeight: 600, fontSize: 13, cursor: 'pointer',
  };
}
