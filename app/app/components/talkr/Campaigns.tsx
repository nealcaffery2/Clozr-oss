'use client';

/**
 * Talkr dialer campaigns, inside CLOZR's Dialer (the Campaigns list beside
 * Recent, Queue and Voicemail).
 *
 * Copied from Talkr apps/web/app/(app)/campaigns/page.tsx: the campaign table
 * (mode, status, lead bar, Activate / Pause / Resume, Stats, Edit), the stats
 * panel with Attach leads, and the New / Edit campaign form (mode, 1–3
 * parallel lines, calling window, attempts per day and total, retry delay,
 * answering-machine detection and the voicemail-drop text). Talkr's page also
 * runs the live session; in CLOZR that is DialSessionBar / DialSessionStart,
 * so this shows DialSessionStart on top instead of a per-row Start session.
 *
 * Talkr enforces the permissions (campaigns.manage, campaigns.run); its
 * refusals are shown as they come back.
 *
 * Leads from CLOZR's own lists come in from People → Actions → Send to Talkr
 * campaign (SendToCampaign below, lib/talkr-campaign-send.ts).
 */

import { useCallback, useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ApiError, api, type CampaignDto, type CampaignSettingsDto, type CampaignStatsDto } from '@/lib/talkr-web/api';
import { sendSellersToCampaign, type SendSeller } from '@/lib/talkr-campaign-send';
import { Icon } from './Icon';
import {
  Button,
  Card,
  EmptyState,
  Eyebrow,
  GridHead,
  GridRow,
  Input,
  Labeled,
  Modal,
  Notice,
  Select,
  StatusMarker,
  TextArea,
  Toggle,
} from './ui';
import { DialSessionStart } from './DialSessionBar';
import '@/app/clozr/talkr-dialer.css';

const LEAD_STATUS_COLORS: Record<string, string> = {
  pending: 'var(--accent)',
  in_progress: 'var(--amber)',
  contacted: 'var(--green)',
  completed: 'var(--muted)',
  suppressed: 'var(--red)',
  removed: 'var(--line)',
};

const CAMPAIGN_STATUS_COLORS: Record<string, string> = {
  active: 'var(--green)',
  paused: 'var(--amber)',
  draft: 'var(--muted-2)',
  archived: 'var(--line)',
};

const MODE_LABEL: Record<string, string> = {
  power: 'Power',
  progressive: 'Progressive',
  parallel: 'Parallel',
  predictive: 'Predictive',
};

function pct(part: number, total: number): string {
  return total > 0 ? `${(part / total) * 100}%` : '0%';
}

function errText(err: unknown): string {
  return err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message;
}

const COLS = '1.7fr 1fr 1.6fr auto';
const MIN_W = 720;

export function CampaignsPanel({ V }: { V: ClozrView }) {
  const linked = V.talkrStatus === 'ok';
  const reloadPicker = V.talkrPhone.session.reloadCampaigns;
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [statsFor, setStatsFor] = useState<Record<string, CampaignStatsDto>>({});
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CampaignDto | 'new' | null>(null);

  const refreshCampaigns = useCallback(async () => {
    try {
      const { campaigns } = await api.listCampaigns();
      setCampaigns(campaigns);
    } catch (err) {
      setError(errText(err));
    }
    // The Dial campaign picker lists active campaigns: keep it in step.
    reloadPicker();
  }, [reloadPicker]);

  useEffect(() => {
    if (linked) void refreshCampaigns();
  }, [linked, refreshCampaigns]);

  async function guard(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    }
  }

  async function toggleStats(campaign: CampaignDto) {
    if (statsFor[campaign.id]) {
      setStatsFor((s) => {
        const nextStats = { ...s };
        delete nextStats[campaign.id];
        return nextStats;
      });
      return;
    }
    await guard(async () => {
      const stats = await api.campaignStats(campaign.id);
      setStatsFor((s) => ({ ...s, [campaign.id]: stats }));
    });
  }

  async function setStatus(campaign: CampaignDto, status: string) {
    await guard(async () => {
      await api.updateCampaign(campaign.id, { status });
      await refreshCampaigns();
    });
  }

  if (!linked) {
    return (
      <EmptyState
        compact
        icon="phone"
        title="Campaigns live in Talkr"
        hint="Link your Talkr sign-in (Settings → Phone) to create campaigns and dial through them here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <DialSessionStart V={V} />
      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex items-center gap-3">
        <Eyebrow>All campaigns</Eyebrow>
        <Button tone="accent" className="ml-auto" onClick={() => setEditing('new')}>
          <Icon name="plus" size={14} />
          New campaign
        </Button>
      </div>

      <Card padded={false} className="overflow-x-auto">
        <GridHead cols={COLS} minWidth={MIN_W}>
          <Eyebrow>Campaign</Eyebrow>
          <Eyebrow>Status</Eyebrow>
          <Eyebrow>Leads</Eyebrow>
          <Eyebrow className="text-right">Actions</Eyebrow>
        </GridHead>

        {campaigns.length === 0 && (
          <EmptyState
            title="No campaigns yet"
            hint="Create one, send sellers to it from People (Actions → Send to Talkr campaign), and dial through them."
            action={
              <Button tone="dark" onClick={() => setEditing('new')}>
                Create a campaign
              </Button>
            }
          />
        )}

        {campaigns.map((campaign, i) => {
          const counts = campaign.lead_counts ?? {};
          const total = Object.values(counts).reduce((a, b) => a + b, 0);
          const stats = statsFor[campaign.id];
          const last = i === campaigns.length - 1;
          const statusColor = CAMPAIGN_STATUS_COLORS[campaign.status] ?? 'var(--muted-2)';
          const ghost = { padding: '8px 11px', font: '600 11.5px/1 var(--sans)' } as const;
          return (
            <div key={campaign.id} style={{ borderBottom: last ? 'none' : '1px solid var(--panel-2)' }}>
              <GridRow cols={COLS} minWidth={MIN_W} style={{ borderBottom: 'none' }}>
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="truncate" style={{ font: '600 13px/1 var(--sans)' }}>
                    {campaign.name}
                  </span>
                  <span style={{ font: '500 10.5px/1 var(--sans)', color: 'var(--muted)' }}>
                    {MODE_LABEL[campaign.mode] ?? campaign.mode} dialer
                    {campaign.mode === 'parallel' && ` · ${campaign.settings.parallelLines ?? 2} lines`}
                    {campaign.settings.callingWindowStart &&
                      ` · ${campaign.settings.callingWindowStart}–${campaign.settings.callingWindowEnd ?? ''} local`}
                  </span>
                </span>

                <StatusMarker color={statusColor} label={campaign.status} />

                <span className="flex min-w-0 flex-col gap-1.5">
                  <span style={{ font: '600 12px/1 var(--sans)' }}>
                    {total} lead{total === 1 ? '' : 's'}
                    <span style={{ font: '500 10.5px/1 var(--sans)', color: 'var(--muted)' }}>
                      {total > 0 && ` · ${counts.pending ?? 0} pending · ${counts.contacted ?? 0} contacted`}
                    </span>
                  </span>
                  <span className="flex h-1.5 overflow-hidden" style={{ borderRadius: 2, background: 'var(--panel-2)' }} aria-hidden>
                    {Object.entries(counts).map(([status, n]) => (
                      <span
                        key={status}
                        title={`${status}: ${n}`}
                        style={{ width: pct(n, total), background: LEAD_STATUS_COLORS[status] ?? 'var(--line)' }}
                      />
                    ))}
                  </span>
                </span>

                <span className="flex items-center justify-end gap-1.5">
                  {campaign.status === 'draft' && (
                    <Button tone="dark" onClick={() => void setStatus(campaign, 'active')} style={ghost}>
                      Activate
                    </Button>
                  )}
                  {campaign.status === 'active' && (
                    <Button tone="ghost" onClick={() => void setStatus(campaign, 'paused')} style={ghost}>
                      <Icon name="pause" size={12} />
                      Pause
                    </Button>
                  )}
                  {campaign.status === 'paused' && (
                    <Button tone="dark" onClick={() => void setStatus(campaign, 'active')} style={ghost}>
                      Resume
                    </Button>
                  )}
                  <Button tone={stats ? 'quiet' : 'ghost'} onClick={() => void toggleStats(campaign)} style={ghost}>
                    <Icon name="grid" size={12} />
                    {stats ? 'Hide stats' : 'Stats'}
                  </Button>
                  <Button tone="ghost" onClick={() => setEditing(campaign)} style={ghost}>
                    <Icon name="settings" size={12} />
                    Edit
                  </Button>
                </span>
              </GridRow>

              {stats && (
                <div className="mx-4 mb-4 flex flex-col gap-3.5 p-4" style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
                  <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    {[
                      { label: 'Calls', value: String(stats.calls.total) },
                      { label: 'Connected', value: String(stats.calls.connected) },
                      { label: 'Abandoned', value: String(stats.calls.abandoned) },
                      {
                        label: `Abandon rate · ${stats.abandonment.window_days}d`,
                        value: `${(stats.abandonment.rate * 100).toFixed(1)}%`,
                        sub: `cap ${stats.abandonment.cap_percent}%`,
                        warn: stats.abandonment.rate * 100 > stats.abandonment.cap_percent,
                      },
                    ].map((k) => (
                      <div key={k.label} className="flex flex-col gap-1.5">
                        <Eyebrow>{k.label}</Eyebrow>
                        <span style={{ font: '700 18px/1 var(--sans)', color: 'warn' in k && k.warn ? 'var(--red)' : 'var(--text)' }}>
                          {k.value}
                          {'sub' in k && k.sub && (
                            <span style={{ font: '500 10.5px/1 var(--sans)', color: 'var(--muted)', marginLeft: 6 }}>{k.sub}</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                  <AttachLeads campaignId={campaign.id} onDone={refreshCampaigns} />
                </div>
              )}
            </div>
          );
        })}
      </Card>

      {editing && (
        <CampaignForm
          campaign={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refreshCampaigns();
          }}
        />
      )}
    </div>
  );
}

/* ── Attach leads ────────────────────────────────────────────────────────── */

function AttachLeads({ campaignId, onDone }: { campaignId: string; onDone: () => Promise<void> }) {
  const [source, setSource] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 pt-3.5" style={{ borderTop: '1px solid var(--line-soft)' }}>
      <Eyebrow>Attach leads</Eyebrow>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="flex-1"
          style={{ minWidth: 200 }}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Lead source filter — blank attaches every lead"
        />
        <Button
          tone="dark"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api
              .attachCampaignLeads(campaignId, { filter: source ? { source } : {} })
              .then(async (r) => {
                setResult(`Attached ${r.attached}, revived ${r.revived}.`);
                await onDone();
              })
              .catch((e: unknown) => setResult(errText(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Attaching…' : 'Attach'}
        </Button>
      </div>
      <span style={{ font: '500 11px/1.3 var(--sans)', color: 'var(--muted)' }}>
        {result ?? 'CLOZR sellers: select them in People, then Actions → Send to Talkr campaign.'}
      </span>
    </div>
  );
}

/* ── Create / edit ───────────────────────────────────────────────────────── */

function CampaignForm({
  campaign,
  onClose,
  onSaved,
}: {
  campaign: CampaignDto | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const s = campaign?.settings ?? {};
  const [name, setName] = useState(campaign?.name ?? '');
  const [mode, setMode] = useState(campaign?.mode ?? 'power');
  const [windowStart, setWindowStart] = useState(s.callingWindowStart ?? '09:00');
  const [windowEnd, setWindowEnd] = useState(s.callingWindowEnd ?? '20:00');
  const [attemptsPerDay, setAttemptsPerDay] = useState(s.maxAttemptsPerDay ?? 2);
  const [attemptsTotal, setAttemptsTotal] = useState(s.maxAttemptsTotal ?? 8);
  const [backoffHours, setBackoffHours] = useState(s.retryBackoffHours ?? 4);
  const [lines, setLines] = useState(s.parallelLines ?? 2);
  const [amdEnabled, setAmdEnabled] = useState(s.amdEnabled ?? false);
  const [amdAction, setAmdAction] = useState<'hangup' | 'voicemail_drop'>(s.amdAction ?? 'hangup');
  const [amdText, setAmdText] = useState(s.amdVoicemailText ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    const settings: CampaignSettingsDto = {
      // Keep what this form does not edit (caller ID, timezone policy, cap).
      ...s,
      callingWindowStart: windowStart,
      callingWindowEnd: windowEnd,
      maxAttemptsPerDay: Number(attemptsPerDay),
      maxAttemptsTotal: Number(attemptsTotal),
      retryBackoffHours: Number(backoffHours),
      parallelLines: Number(lines),
      amdEnabled,
      amdAction,
      ...(amdText ? { amdVoicemailText: amdText } : {}),
    };
    try {
      if (campaign) await api.updateCampaign(campaign.id, { name: name.trim(), mode, settings });
      else await api.createCampaign({ name: name.trim(), mode, settings });
      await onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={campaign ? 'Edit campaign' : 'New campaign'} onClose={onClose}>
      <div className="talkr-dialer flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Name" className="sm:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Austin absentee owners" autoFocus />
          </Labeled>
          <Labeled label="Dialer mode">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="power">Power — you press Next</option>
              <option value="progressive">Progressive — auto-advances</option>
              <option value="parallel">Parallel — multi-line</option>
              {/* CLOZR runs predictive (useDialSession); Talkr's own page leaves it off. */}
              <option value="predictive">Predictive — dials ahead, drops a voicemail on machines</option>
            </Select>
          </Labeled>
          <Labeled label="Parallel lines · max 3">
            <Input type="number" min={1} max={3} value={lines} onChange={(e) => setLines(Number(e.target.value))} disabled={mode !== 'parallel'} />
          </Labeled>
        </div>

        <section className="flex flex-col gap-3">
          <Eyebrow>Calling window · lead’s local time</Eyebrow>
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Start">
              <Input value={windowStart} onChange={(e) => setWindowStart(e.target.value)} placeholder="09:00" />
            </Labeled>
            <Labeled label="End">
              <Input value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} placeholder="20:00" />
            </Labeled>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <Eyebrow>Attempts</Eyebrow>
          <div className="grid gap-3 sm:grid-cols-3">
            <Labeled label="Per day">
              <Input type="number" min={1} max={6} value={attemptsPerDay} onChange={(e) => setAttemptsPerDay(Number(e.target.value))} />
            </Labeled>
            <Labeled label="Total">
              <Input type="number" min={1} max={30} value={attemptsTotal} onChange={(e) => setAttemptsTotal(Number(e.target.value))} />
            </Labeled>
            <Labeled label="Retry after · hours">
              <Input type="number" min={1} max={72} value={backoffHours} onChange={(e) => setBackoffHours(Number(e.target.value))} />
            </Labeled>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span style={{ font: '600 12.5px/1 var(--sans)' }}>Answering machine detection</span>
              <span style={{ font: '500 10.5px/1.3 var(--sans)', color: 'var(--muted)' }}>Parallel and predictive sessions. Decide what happens when a machine picks up.</span>
            </div>
            <Toggle on={amdEnabled} onChange={setAmdEnabled} label="Answering machine detection" />
          </div>
          {amdEnabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="On machine">
                <Select value={amdAction} onChange={(e) => setAmdAction(e.target.value as 'hangup' | 'voicemail_drop')}>
                  <option value="hangup">Hang up</option>
                  <option value="voicemail_drop">Drop a voicemail</option>
                </Select>
              </Labeled>
              {amdAction === 'voicemail_drop' && (
                <Labeled label="Voicemail message" className="sm:col-span-2">
                  <TextArea value={amdText} onChange={(e) => setAmdText(e.target.value)} rows={3} placeholder="Hi, this is Alex with Acme Homes…" />
                </Labeled>
              )}
            </div>
          )}
        </section>

        <span style={{ font: '500 10.5px/1.45 var(--sans)', color: 'var(--muted-2)' }}>
          The abandonment cap is fixed at 3% of answered calls (FTC guidance). Parallel sessions drop to one line automatically
          when it is breached.
        </span>

        {error && <Notice tone="error">{error}</Notice>}

        <div className="flex items-center justify-end gap-2" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="accent" onClick={() => void save()} disabled={!name.trim() || saving}>
            {saving ? 'Saving…' : campaign ? 'Save changes' : 'Create campaign'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Send CLOZR sellers to a campaign (People → Actions) ─────────────────── */

const NEW = '__new__';

/**
 * Talkr's "Call N contacts" dial-list modal (apps/web/app/(app)/contacts/page.tsx
 * DialListModal), fed CLOZR's selected sellers: a new campaign by name, or one
 * that already exists.
 */
export function SendToCampaign({
  sellers,
  workspaceId,
  onClose,
  onDone,
}: {
  sellers: SendSeller[];
  workspaceId: number | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [campaigns, setCampaigns] = useState<CampaignDto[] | null>(null);
  const [target, setTarget] = useState(NEW);
  const [name, setName] = useState(`CLOZR ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listCampaigns()
      .then(({ campaigns: rows }) => setCampaigns(rows.filter((c) => c.status !== 'archived')))
      .catch((e: unknown) => {
        setCampaigns([]);
        setErr(errText(e));
      });
  }, []);

  const confirm = async () => {
    if (busy || workspaceId === null) return;
    setErr(null);
    try {
      const r = await sendSellersToCampaign({
        workspaceId,
        sellers,
        target: target === NEW ? { name: name.trim() || 'CLOZR sellers' } : { campaignId: target, name: campaigns?.find((c) => c.id === target)?.name ?? 'the campaign' },
        progress: setBusy,
      });
      const left = [
        r.dnc ? `${r.dnc} do not call` : '',
        r.noNumber ? `${r.noNumber} no good number` : '',
        r.noLead ? `${r.noLead} not enrolled (no property address in Talkr)` : '',
      ].filter(Boolean);
      onDone(`${r.enrolled} enrolled in ${r.campaignName}${left.length ? ` · skipped ${left.join(', ')}` : ''}. Dial it from Dialer → Campaigns.`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const n = sellers.length;
  // People is outside the dialer's token scope (.talkr-dialer): the modal brings it.
  return (
    <div className="talkr-dialer">
    <Modal title={`Call ${n.toLocaleString()} seller${n === 1 ? '' : 's'} from Talkr`} onClose={onClose} width={440}>
      <form
        className="talkr-dialer flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <p style={{ font: '400 12.5px/1.5 var(--sans)', color: 'var(--muted)' }}>
          Every good number each seller has goes to Talkr (do-not-call and wrong numbers stay behind), matched to the Talkr
          contact with that number so nobody is added twice.
        </p>
        <Labeled label="Campaign">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!campaigns}>
            <option value={NEW}>New campaign…</option>
            {(campaigns ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.status}
              </option>
            ))}
          </Select>
        </Labeled>
        {target === NEW && (
          <Labeled label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Labeled>
        )}
        {err && <Notice tone="error">{err}</Notice>}
        <div className="flex items-center justify-end gap-2" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="accent" type="submit" disabled={!!busy || workspaceId === null || n === 0}>
            <Icon name="phone" size={14} />
            {busy ?? 'Send to campaign'}
          </Button>
        </div>
      </form>
    </Modal>
    </div>
  );
}
