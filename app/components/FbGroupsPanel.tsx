// Facebook groups and the deal-post commenter, moved out of Deal Machine.
// The extension still reads dm_groups and dm_settings.facebook. This is the screen that edits them.
'use client';

import React, { useEffect, useState } from 'react';
import { BUYR } from '@/app/clozr/brand';
import {
  type DealMachineState, type DmGroup,
  addGroups, loadDealMachine, removeGroup, saveSettings, sendCommand, since, updateGroup,
} from '@/lib/deal-machine';

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e4e4e7', borderRadius: '14px', padding: '14px 16px' };
const h2: React.CSSProperties = { margin: '0 0 4px', fontSize: '14px', fontWeight: 650, color: '#18181b' };
const sub: React.CSSProperties = { margin: '0 0 12px', fontSize: '12.5px', color: '#71717a', lineHeight: 1.45 };
const input: React.CSSProperties = { height: '34px', padding: '0 10px', borderRadius: '9px', border: '1px solid #d4d4d8', background: '#fff', fontSize: '13px', color: '#18181b', width: '100%', outline: 'none' };
const textarea: React.CSSProperties = { ...input, height: 'auto', minHeight: '72px', padding: '8px 10px', fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.4 };
const th: React.CSSProperties = { textAlign: 'left', fontSize: '11px', color: '#71717a', fontWeight: 600, padding: '8px 10px', borderBottom: '1px solid #f0f0f1', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '9px 10px', fontSize: '12.5px', borderBottom: '1px solid #f0f0f1', color: '#18181b', verticalAlign: 'middle' };

function Btn({ onClick, disabled, children, solid }: { onClick?: () => void; disabled?: boolean; children: React.ReactNode; solid?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} style={{ height: '30px', padding: '0 10px', borderRadius: '8px', border: `1px solid ${solid ? BUYR : '#e4e4e7'}`, background: solid ? BUYR : '#fff', color: solid ? '#fff' : '#18181b', fontSize: '12px', fontWeight: 650, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 }}>
      {children}
    </button>
  );
}

export function FbGroupsPanel({ workspaceId, canOperate, onToast }: {
  workspaceId: number;
  canOperate: boolean;
  onToast: (m: string) => void;
}) {
  const [state, setState] = useState<DealMachineState | null>(null);
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState('');
  const [tags, setTags] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadDealMachine(workspaceId).then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [workspaceId, tick]);

  const reload = () => setTick((n) => n + 1);
  const disabled = !canOperate || busy || !state?.key;

  async function cmd(command: 'pull_groups' | 'fb_discovery' | 'join_groups') {
    setBusy(true);
    const r = await sendCommand(workspaceId, command);
    setBusy(false);
    setNote(r.ok ? 'Queued. The extension picks it up on its next check-in.' : (r.message ?? 'Could not queue that.'));
    if (r.ok) onToast('Queued for the extension.');
    reload();
  }

  async function setFacebook(patch: Partial<DealMachineState['settings']['facebook']>) {
    if (!state) return;
    setBusy(true);
    const next = { ...state.settings, facebook: { ...state.settings.facebook, ...patch } };
    const r = await saveSettings(workspaceId, next);
    setBusy(false);
    setNote(r.ok ? 'Saved. The extension applies it on its next sync.' : (r.message ?? 'Could not save.'));
    if (r.ok) reload();
  }

  async function add() {
    const urls = draft.split(/\r?\n|,|\s+/).map((x) => x.trim()).filter(Boolean);
    if (!urls.length) return;
    setBusy(true);
    const r = await addGroups(workspaceId, urls, tags.split(',').map((t) => t.trim()).filter(Boolean));
    setBusy(false);
    if (!r.ok && !r.added) { setNote(r.message ?? 'Could not add those.'); return; }
    setNote(`${r.added} group${r.added === 1 ? '' : 's'} added${r.rejected?.length ? ` · ${r.rejected.length} skipped` : ''}.`);
    setDraft(''); setTags(''); reload();
  }

  const groups = state?.groups ?? [];
  const shown = groups.filter((g) => !q || g.url.toLowerCase().includes(q.toLowerCase()) || (g.name ?? '').toLowerCase().includes(q.toLowerCase()) || g.tags.some((t) => t.toLowerCase().includes(q.toLowerCase())));
  const slug = (u: string) => u.replace(/^https?:\/\/(www\.)?facebook\.com\/groups\//i, '').replace(/\/$/, '');
  const fb = state?.settings.facebook;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={card}>
        <h2 style={h2}>Facebook poster</h2>
        <p style={sub}>The extension comments on deal posts and can join groups it discovers. Both stay rate-limited (45–90 seconds between comments).</p>
        <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', fontSize: '13px', marginTop: '8px' }}>
          <input type="checkbox" checked={!!fb?.autoComment} disabled={!canOperate || busy || !state} onChange={(e) => void setFacebook({ autoComment: e.target.checked })} />
          <span><strong>Comment on deal posts</strong> — leaves deals@yourcompany.com on deal posts that have no contact info.</span>
        </label>
        <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', fontSize: '13px', marginTop: '8px' }}>
          <input type="checkbox" checked={!!fb?.autoJoin} disabled={!canOperate || busy || !state} onChange={(e) => void setFacebook({ autoJoin: e.target.checked })} />
          <span><strong>Auto-join discovered groups</strong> — the discovery step sends join requests instead of only listing what it found.</span>
        </label>
        {note ? <p style={{ ...sub, margin: '10px 0 0', color: '#3f3f46' }}>{note}</p> : null}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
          <div>
            <h2 style={h2}>Facebook groups</h2>
            <p style={{ ...sub, marginBottom: 0 }}>Only groups on this list are scraped. A group is worked when it has 10+ posts a day or 10k+ members.</p>
          </div>
          <div style={{ flex: 1 }} />
          <Btn disabled={disabled} onClick={() => void cmd('pull_groups')}>Pull my Facebook groups</Btn>
          <Btn disabled={disabled} onClick={() => void cmd('fb_discovery')}>Discover &amp; join</Btn>
          <Btn solid disabled={disabled} onClick={() => void cmd('join_groups')}>Join saved groups</Btn>
        </div>
      </div>

      <div style={card}>
        <h2 style={h2}>Add groups</h2>
        <p style={sub}>Paste links, one per line. Anything that is not a facebook.com/groups link is skipped.</p>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={'https://www.facebook.com/groups/houston-wholesale-deals/'} disabled={!canOperate} style={textarea} />
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma-separated" disabled={!canOperate} style={{ ...input, maxWidth: '280px' }} />
          <Btn solid disabled={!canOperate || busy || !draft.trim()} onClick={() => void add()}>{busy ? 'Working…' : 'Add to list'}</Btn>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
          <h2 style={{ ...h2, margin: 0 }}>{groups.filter((g) => g.active).length} groups on</h2>
          <div style={{ flex: 1 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups" style={{ ...input, width: '200px', height: '30px' }} />
        </div>
        {!state ? <p style={sub}>Loading groups…</p> : shown.length === 0 ? <p style={sub}>{groups.length ? 'No group matches.' : 'No groups yet. Paste links, or pull the groups your Facebook account is already in.'}</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['', 'Group', 'Tags', 'Members', 'Posts/day', 'Last scrape', ''].map((h) => <th key={h || 'on'} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {shown.map((g) => <GroupRow key={g.id} g={g} slug={slug(g.url)} canOperate={canOperate} onChange={reload} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function GroupRow({ g, slug, canOperate, onChange }: { g: DmGroup; slug: string; canOperate: boolean; onChange: () => void }) {
  return (
    <tr style={{ opacity: g.active ? 1 : 0.55 }}>
      <td style={{ ...td, width: '34px' }}>
        <input type="checkbox" checked={g.active} disabled={!canOperate} onChange={() => void updateGroup(g.id, { active: !g.active }).then(onChange)} />
      </td>
      <td style={td}>
        <a href={g.url} target="_blank" rel="noreferrer" style={{ color: '#18181b', fontWeight: 600, textDecoration: 'none' }}>{g.name ?? slug}</a>
      </td>
      <td style={td}>{g.tags.join(', ') || '—'}</td>
      <td style={td}>{g.members !== null ? g.members.toLocaleString() : '—'}</td>
      <td style={td}>{g.postsPerDay ?? '—'}</td>
      <td style={td}>{since(g.lastScrapedAt)}</td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>
        {canOperate ? (
          <>
            <Btn onClick={() => {
              const name = window.prompt('Group name', g.name ?? '');
              if (name === null) return;
              void updateGroup(g.id, { name: name.trim() || null }).then(onChange);
            }}>Name</Btn>{' '}
            <Btn onClick={() => {
              const t = window.prompt('Tags, comma-separated', g.tags.join(', '));
              if (t === null) return;
              void updateGroup(g.id, { tags: t.split(',').map((x) => x.trim()).filter(Boolean) }).then(onChange);
            }}>Tags</Btn>{' '}
            <Btn onClick={() => {
              if (!window.confirm(`Remove ${g.name ?? g.url}?`)) return;
              void removeGroup(g.id).then(onChange);
            }}>Remove</Btn>
          </>
        ) : null}
      </td>
    </tr>
  );
}
