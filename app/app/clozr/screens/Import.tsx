// Bulk import — sellers, buyers, vendors or a vendor's submissions, from a
// paste, a file (CSV, Excel .xlsx / .xls, LibreOffice .ods) or a Google Sheets link.
//
// Five steps on one page: load the table; check the mapping (the matcher's
// guess is already there, with a confidence per column, and Claude can remap
// the uncertain ones); preview the values as they will be written; review
// duplicates against the file and against CLOZR (nothing is written before
// this, nothing is ever created twice, and records CLOZR already has wait for
// one explicit choice: add the file's new info, override, or skip); assign and
// import, with a per-row report to download. COMPR is never pulled unless it
// is switched on for this import and the count is confirmed — each report is
// billed.
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ReadOnlyNote } from '@/components/ViewAs';
import type { ClozrView } from '@/app/clozr/view';
import { Empty } from '@/components/ds/Empty';
import {
  type AnyRecord, type Confidences, type ImportRecord, type ImportResult, type Mapping, PREVIEW_COLS, type RecordKind, type ReportRow, type Review,
  TARGETS_BY_KIND, type Table, type Target,
  aiMap, applyFor, autoMap, importReportCsv, isMultiTarget, lastImports, parseTable, previewCells, reviewDuplicates, runImport,
} from '@/lib/import';
import { type Action, type Match, actionsFor, defaultAction, summarize } from '@/lib/import-dedupe';
import { runComprMany } from '@/lib/compr';
import { bestSheet, isTextTable, readSpreadsheet, rowsToCsv, type SheetRows } from '@/lib/sheet-file';
import { SUBMITTER_TYPES, findIndexedVendor, indexVendors, mainSubmitter, partnerOnRow, previewSubmissions, runSubmissionImport } from '@/lib/submission-import';
import { submissionCounts } from '@/lib/submission-match';
import { supabase } from '@/lib/supabase';
import { comprCandidates, comprConfirmText, comprQueue } from '@/lib/import-compr';
import { type PlanSummary, type Teammate, listPlans, listTeammates } from '@/lib/plans';
import { BUYER_STAGES, PODIO_SUBMISSION_STAGES, SELLER_STAGES } from '@/lib/stages';
import { sessionRole, useSession } from '@/lib/session';
import { isAdmin, canSee, type Role } from '@/lib/team';
import { resetLeaderboardReps } from '@/lib/floor-store';
import { pauseLive, resumeLive } from '@/lib/use-crm';
import { raiseToast } from '@/app/clozr/toastStore';

const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const h2: React.CSSProperties = { margin: '0 0 2px', fontSize: '14px', fontWeight: 700, letterSpacing: '-0.01em' };
const sub: React.CSSProperties = { margin: '0 0 12px', fontSize: '12px', color: 'var(--meta, #71717a)', lineHeight: 1.5 };
const btn: React.CSSProperties = { height: '32px', padding: '0 12px', borderRadius: '9px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', color: 'var(--ink, #18181b)', whiteSpace: 'nowrap' };
const primary: React.CSSProperties = { ...btn, border: '1px solid #0A8560', background: '#0A8560', color: '#fff' };
const select: React.CSSProperties = { height: '30px', padding: '0 8px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '12.5px', background: 'var(--canvas, #fafafa)', color: 'var(--ink, #18181b)', maxWidth: '100%' };
const mono: React.CSSProperties = { fontSize: '11.5px', color: 'var(--muted, #52525b)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const th: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--divider, #e4e4e7)', whiteSpace: 'nowrap', textAlign: 'left', color: 'var(--meta, #71717a)', fontSize: '11px' };
const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--divider-2, #f0f0f1)', whiteSpace: 'nowrap', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'top' };
const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 600 };
const stickyTh: React.CSSProperties = { ...th, position: 'sticky', top: 0, background: 'var(--surface, #fff)', zIndex: 1 };

/** A large paste is parsed off the main thread. A short one stays here, and a worker that fails parses here too. */
function parseOffMain(text: string): Promise<Table> {
  if (text.length <= 8000 || typeof Worker === 'undefined') return Promise.resolve(parseTable(text));
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../../../lib/parse-table.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(parseTable(text));
      return;
    }
    let settled = false;
    let timer = 0;
    const finish = (t: Table) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker.terminate();
      resolve(t);
    };
    timer = window.setTimeout(() => finish(parseTable(text)), 30_000);
    worker.onmessage = (e: MessageEvent<Table>) => finish(e.data);
    worker.onerror = () => finish(parseTable(text));
    worker.postMessage({ text });
  });
}

function rowWindow(scrollTop: number, count: number, rowHeight: number, viewport: number) {
  const over = 4;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - over);
  const end = Math.min(count, start + Math.ceil(viewport / rowHeight) + over * 2);
  return { start, end, padTop: start * rowHeight, padBottom: Math.max(0, (count - end) * rowHeight) };
}

/** What the screen imports. 'submissions' is a vendor's list of houses: mapped like sellers, written as deals. */
type Kind = RecordKind | 'submissions';
const mapKindOf = (k: Kind): RecordKind => (k === 'submissions' ? 'sellers' : k);

const KINDS: { key: Kind; label: string; noun: string; identity: Target[]; identityHint: string }[] = [
  { key: 'sellers', label: 'Sellers', noun: 'leads', identity: ['name', 'first_name', 'last_name', 'phone', 'addr', 'full_address'], identityHint: 'a name, a phone or an address' },
  { key: 'submissions', label: 'Vendor submissions', noun: 'submissions', identity: ['addr', 'full_address'], identityHint: 'the property address' },
  { key: 'buyers', label: 'Buyers', noun: 'buyers', identity: ['name', 'first_name', 'last_name', 'company'], identityHint: 'a buyer name or company' },
  { key: 'vendors', label: 'Vendors', noun: 'vendors', identity: ['name', 'contact_name'], identityHint: 'a business or contact name' },
];
/** vendors.service_type values the vendor import can set on every row. */
const VENDOR_TYPES = ['Title Company', 'Lender', 'Contractor', 'Insurance', 'Survey', 'Notary', 'Photography', 'Photographer/Notary', 'Attorney', 'Wholesaler', 'Institutional seller', 'Realtor'];

const SAMPLES: Record<Kind, string> = {
  submissions: `Property Address,City,State,Zip,Beds,Baths,Sqft,Year Built,List Price,Offer Due,Photos,Notes
4410 Ridgecrest Dr,San Antonio,TX,78228,3,2,1450,1978,"$189,000",10/3/2026,https://drive.google.com/drive/folders/abc,Needs roof
918 Hemlock Ln,Houston,TX,77073,4,2.5,2105,2004,"$245,000",10/3/2026,,Tenant occupied`,
  sellers: `Name,Phone,Email,Property Address,City,State,Zip,Asking,Motivation,Lead Source
Karen Daniels,(936) 555-0142,karen@example.com,330 Vista Dr,Shepherd,TX,77371,"$110,000",Needs full renovation,Direct Mail
Ronald Moore,713-555-0192,,1803 Cypress Lane,Houston,TX,77008,"205,000",Tired landlord,Cold call
Ron Moore,713.555.0192,ron@example.com,,,,,,,Cold call`,
  buyers: `Buyer Name,Company,Phone,Email,Strategy,Property Type,Markets,Min Price,Max Price,Min Bedrooms,VIP
Maria Lopez,Lopez Holdings LLC,(210) 555-0100,maria@lopez.com,Fix n' Flip,Single Family Residential,"San Antonio, 78254",$80K,$350K,3,yes
Sam Reed,Reed Capital,512-555-0111,sam@reedcap.com,Buy n' Hold,Single Family Residential,Austin,,"$250,000",2,`,
  vendors: `Business Name,Contact Name,Phone,Email,Service Type,Service Area
Alamo Title,Jen Park,210-555-0199,jen@alamotitle.com,Title Company,San Antonio
Hill Country Lending,Ben Ruiz,512-555-0177,ben@hcl.com,Lender,Austin`,
};

const CONF: Record<string, { text: string; bg: string; fg: string }> = {
  high: { text: 'Sure', bg: 'var(--positive-soft, #dcfce7)', fg: '#15803d' },
  medium: { text: 'Check', bg: 'var(--caution-soft, #fef3c7)', fg: '#92400e' },
  low: { text: 'Unmapped', bg: 'var(--surface-2, #f4f4f5)', fg: 'var(--meta, #71717a)' },
  extra: { text: 'Kept as extra info', bg: 'var(--tint-blue, #eff6ff)', fg: '#1d4ed8' },
  skip: { text: 'Not imported', bg: 'var(--surface-2, #f4f4f5)', fg: 'var(--meta, #71717a)' },
};
const ACTION_LABEL: Record<Action, string> = {
  create: 'Create new', skip: 'Skip', fill: 'Add new info', overwrite: 'Override with file', coseller: 'Add as co-seller', merge: 'Merge into first row',
};
/** The one choice for every record CLOZR already has. */
const EXISTING_CHOICES: { a: Action; label: string }[] = [
  { a: 'fill', label: 'Add new info to them' },
  { a: 'overwrite', label: 'Override them with this file' },
  { a: 'skip', label: 'Skip them' },
];
const matchText = (m: Match) =>
  m.kind === 'file' ? `Same ${m.by} as row ${m.row + 1} in this file`
    : m.kind === 'existing' ? `Already in CLOZR (${m.by})`
      : m.kind === 'conflict' ? 'Different seller on an existing property' : 'New';

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Import({ V }: { V: ClozrView }) {
  const s = useSession();
  const live = V.isLiveData;
  const wsId = s.workspace?.id ?? null;
  const role = sessionRole(s);
  // Buyers need the buyer list; sellers, vendors and submissions live on People.
  // An SDR has only Buyers, so they import buyer records and nothing else.
  const seesPeople = canSee(role, 'people') === true;
  const seesBuyers = canSee(role, 'buyers') === true;
  const kinds = KINDS.filter((k) => (k.key === 'buyers' ? seesBuyers : seesPeople));
  const [kindState, setKindState] = useState<Kind>(V.importKind ?? 'sellers');
  const kind: Kind = (kindState === 'buyers' ? seesBuyers : seesPeople) ? kindState : seesPeople ? 'sellers' : 'buyers';
  const mapKind = mapKindOf(kind);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<Table | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [conf, setConf] = useState<Confidences>({});
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [actions, setActions] = useState<(Action | null)[]>([]);
  const [checking, setChecking] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState('Import');
  const [assignees, setAssignees] = useState<string[]>([]);
  /** 'same' = the assigned rep, '' = nobody, else a teammate's id. */
  const [underwriter, setUnderwriter] = useState<string>('same');
  /** Off for every import until switched on: each COMPR report is billed. */
  const [runComprOnImport, setRunComprOnImport] = useState(false);
  const [stage, setStage] = useState<string>('');
  const [buyerStatus, setBuyerStatus] = useState<string>('Active');
  const [tagText, setTagText] = useState('');
  const [planId, setPlanId] = useState<number | null>(null);
  const [applyToUpdated, setApplyToUpdated] = useState(false);
  const [team, setTeam] = useState<Teammate[]>([]);
  const [zeroIds, setZeroIds] = useState<string[]>([]);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [lastRun, setLastRun] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ result: ImportResult; report: ReportRow[]; ids: string[] } | null>(null);
  const [sheets, setSheets] = useState<SheetRows[]>([]);
  const [sheetName, setSheetName] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [reading, setReading] = useState<string | null>(null);
  const [previewScroll, setPreviewScroll] = useState(0);
  const [dupScroll, setDupScroll] = useState(0);
  const previewBox = useRef<HTMLDivElement>(null);
  const dupBox = useRef<HTMLDivElement>(null);
  // Vendor submissions: who sent the list, and what kind of vendor they are.
  const [vendorName, setVendorName] = useState('');
  const [vendorType, setVendorType] = useState<string>(SUBMITTER_TYPES[0].value);
  const [subStage, setSubStage] = useState('New Submission');
  const [vendorList, setVendorList] = useState<{ id: number; name: string; type: string | null }[]>([]);
  // Vendors: one type for every row ('' keeps the file's).
  const [vendorTypeAll, setVendorTypeAll] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const K = KINDS.find((k) => k.key === kind)!;
  const targets = TARGETS_BY_KIND[mapKind];

  useEffect(() => {
    if (!live || !wsId) return;
    void listTeammates(wsId).then(setTeam);
    void listPlans(wsId).then((r) => setPlans(r.plans.filter((p) => p.active)));
    void lastImports(wsId).then(setLastRun);
    if (supabase) {
      void supabase.from('vendors').select('id, business_name, service_type').eq('workspace_id', wsId).order('business_name').limit(2000)
        .then(({ data }) => setVendorList((data ?? []).map((v) => ({ id: v.id, name: v.business_name, type: v.service_type }))));
    }
  }, [live, wsId]);
  const vendorIndex = useMemo(
    () => indexVendors(vendorList.map((v) => ({ id: v.id, business_name: v.name, service_type: v.type }))),
    [vendorList],
  );
  const knownHit = findIndexedVendor(vendorIndex, vendorName);
  const knownVendor = knownHit ? { id: knownHit.id, name: knownHit.business_name, type: knownHit.service_type } : null;
  const recheck = useRef<number | undefined>(undefined);
  // Picking an existing vendor shows its type, so changing it is a deliberate choice.
  function chooseVendor(name: string) {
    setVendorName(name);
    const hit = findIndexedVendor(vendorIndex, name);
    if (hit?.service_type && SUBMITTER_TYPES.some((t) => t.value === hit.service_type)) setVendorType(hit.service_type);
    // Another vendor has other houses already here: check the file against theirs once the typing stops.
    if (kind === 'submissions' && review) {
      window.clearTimeout(recheck.current);
      recheck.current = window.setTimeout(() => void checkDuplicates(name), 600);
    }
  }

  function remap(t: Table, k: Kind) {
    const c: Confidences = {};
    const m = autoMap(t, mapKindOf(k), c);
    setMapping(m);
    setConf(c);
    // Submissions from a sheet that names its partner per row (Podio's Entity Name): the main one fills the vendor in.
    if (k === 'submissions' && !vendorName.trim()) {
      const main = mainSubmitter(applyFor('sellers', t, m) as ImportRecord[]);
      if (main) chooseVendor(main);
    }
    setReasons({});
    setReview(null);
    setResult(null);
  }

  function setKind(k: Kind) {
    setKindState(k);
    setRunComprOnImport(false);
    if (table) remap(table, k);
  }

  // A slow worker parse must not land on top of a newer paste or sample.
  const loadSeq = useRef(0);
  async function load(raw: string, name: string | null) {
    const seq = ++loadSeq.current;
    if (raw.length > 8000) setReading('Reading the table…');
    const t = await parseOffMain(raw);
    if (seq !== loadSeq.current) return;
    setReading(null);
    if (!t.headers.length || !t.rows.length) {
      setNote({ ok: false, text: 'That does not look like a table — it needs a header row and at least one row of data.' });
      return;
    }
    setFileName(name);
    setTable(t);
    setPreviewScroll(0);
    setDupScroll(0);
    previewBox.current?.scrollTo(0, 0);
    dupBox.current?.scrollTo(0, 0);
    setRunComprOnImport(false);
    remap(t, kind);
    setNote({ ok: true, text: `${t.rows.length.toLocaleString()} rows, ${t.headers.length} columns, mapped automatically. Check anything marked "Check"; a column with no field is kept as extra info on the record, never dropped.` });
    if (name) {
      const label = name.replace(/\.(csv|tsv|txt|xlsx|xlsm|xls|ods)$/i, '');
      setSourceLabel(label);
      // "Offerpad 10-02.xlsx": the vendor named in the file name is the one that sent it.
      const hit = vendorList.filter((v) => v.name.length > 2 && label.toLowerCase().includes(v.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
      if (hit && !vendorName) chooseVendor(hit.name);
    }
  }

  function loadSheet(all: SheetRows[], pick: SheetRows | null, name: string) {
    setSheets(all.length > 1 ? all : []);
    if (!pick || !pick.rows.length) { setNote({ ok: false, text: 'That file has no rows in it.' }); return; }
    setSheetName(pick.sheet);
    const csv = rowsToCsv(pick.rows);
    setText('');
    void load(csv, all.length > 1 ? `${name} · ${pick.sheet}` : name);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (isTextTable(f.name, f.type)) { setSheets([]); await load(await f.text(), f.name); return; }
    setReading(`Reading ${f.name}…`);
    try {
      const all = await readSpreadsheet(f.name, await f.arrayBuffer());
      loadSheet(all, bestSheet(all), f.name);
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setReading(null);
    }
  }

  function pickSheet(name: string) {
    const pick = sheets.find((x) => x.sheet === name) ?? null;
    if (pick) loadSheet(sheets, pick, (fileName ?? 'Sheet').split(' · ')[0]);
  }

  async function onSheetLink() {
    if (!supabase || !sheetUrl.trim()) return;
    setReading('Reading the Google Sheet…');
    setNote(null);
    const { data, error } = await supabase.functions.invoke('map-columns', { body: { action: 'sheet', url: sheetUrl.trim() } });
    setReading(null);
    let message = error?.message ?? null;
    if (error) {
      try {
        const ctx = (error as { context?: Response }).context;
        if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
      } catch { /* keep the transport message */ }
    }
    const r = data as { ok?: boolean; csv?: string; name?: string | null; error?: string } | null;
    if (message || !r?.ok || !r.csv) return setNote({ ok: false, text: message ?? r?.error ?? 'Google sent nothing back.' });
    setSheets([]);
    await load(r.csv, r.name || 'Google Sheet');
  }

  async function askAi() {
    if (!table) return;
    setAiBusy(true);
    setNote(null);
    const r = await aiMap(table, mapKind);
    setAiBusy(false);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    // Exact header matches stay; Claude decides the rest.
    const sure = Object.entries(conf).filter(([, c]) => c === 'high').map(([i]) => Number(i));
    const next: Mapping = { ...r.mapping };
    const nextConf: Confidences = { ...r.confidence };
    const taken = new Set(sure.map((i) => mapping[i]));
    for (const i of sure) { next[i] = mapping[i]; nextConf[i] = 'high'; }
    // A single-value field stays with the column already sure of it; the other column is kept as extra info.
    for (const [i, t] of Object.entries(next)) if (!sure.includes(Number(i)) && !isMultiTarget(t) && taken.has(t)) next[Number(i)] = 'extra';
    setMapping(next);
    setConf(nextConf);
    setReasons(r.reasons);
    setReview(null);
    setNote({ ok: true, text: 'Claude mapped the uncertain columns. Its reasoning is under each field — correct anything that looks wrong.' });
  }

  // A submission is a house: it needs an address, and the owner's name is optional.
  const records: AnyRecord[] = useMemo(() => {
    if (!table) return [];
    const rows = applyFor(mapKind, table, mapping);
    return kind === 'submissions' ? rows.map((r) => ({ ...r, problem: (r as ImportRecord).addr ? null : 'No property address' })) : rows;
  }, [kind, mapKind, table, mapping]);
  const problems = useMemo(() => records.map((r) => r.problem), [records]);
  // Vendor submissions whose rows name their partner ("Submitted by", Podio's Entity Name): each row goes to its own vendor.
  const partners = useMemo(() => {
    if (kind !== 'submissions') return { names: [] as string[], everyRow: false };
    const rows = (records as ImportRecord[]).filter((r) => !r.problem);
    const names = [...new Map(rows.map((r) => partnerOnRow(r)).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()];
    return { names, everyRow: rows.length > 0 && rows.every((r) => partnerOnRow(r)) };
  }, [kind, records]);
  const vendorMissing = kind === 'submissions' && !vendorName.trim() && !partners.everyRow;
  const importable = problems.filter((p) => !p).length;
  const mapped = Object.values(mapping).filter((t) => t !== 'skip' && t !== 'extra');
  const keptExtra = Object.values(mapping).filter((t) => t === 'extra').length;
  const leftOut = Object.values(mapping).filter((t) => t === 'skip').length;
  const hasIdentity = mapped.some((t) => K.identity.includes(t));

  const grouped = useMemo(() => {
    const g = new Map<string, typeof targets>();
    for (const t of targets) g.set(t.group, [...(g.get(t.group) ?? []), t]);
    return [...g.entries()];
  }, [targets]);

  async function checkDuplicates(vendorNow = vendorName) {
    if (!wsId) return;
    // A vendor's submissions are matched to the deals that partner already has
    // here (the row's id, else the same property): those fill their deal's
    // blanks, with no choice to make, and the rest are new.
    if (kind === 'submissions') {
      setChecking('Looking for houses CLOZR already has…');
      setResult(null);
      const hits = await previewSubmissions(wsId, records as ImportRecord[], { vendorId: findIndexedVendor(vendorIndex, vendorNow)?.id ?? null, vendorName: vendorNow });
      setChecking(null);
      setReview({ matches: hits.map((h): Match => (h ? { kind: 'existing', id: h.id, by: h.by } : { kind: 'new' })), existing: {}, addressKeys: records.map(() => null) });
      setActions(hits.map((h): Action => (h ? 'fill' : 'create')));
      return;
    }
    setChecking('Reading what CLOZR already has…');
    setResult(null);
    let r: Review;
    try {
      r = await reviewDuplicates(mapKind, wsId, records, (done, total) => setChecking(`Matching addresses ${done} / ${total}…`));
    } catch {
      // A partial read would let the import create duplicates, so a failed check stops here.
      raiseToast('Could not read what CLOZR already has. Nothing was imported; check again.', 'error');
      return;
    } finally {
      setChecking(null);
    }
    setReview(r);
    setActions(r.matches.map(defaultAction));
  }

  const summary = review ? summarize(review.matches, actions, problems) : null;
  const dupRows = review ? review.matches.map((m, i) => ({ m, i })).filter(({ m, i }) => m.kind !== 'new' && !problems[i]) : [];
  const setAll = (pred: (m: Match) => boolean, a: Action) =>
    setActions((cur) => cur.map((x, i) => (review && pred(review.matches[i]) && actionsFor(review.matches[i]).includes(a) ? a : x)));
  const counts = review ? {
    file: review.matches.filter((m) => m.kind === 'file').length,
    existing: review.matches.filter((m, i) => m.kind === 'existing' && !problems[i]).length,
    conflict: review.matches.filter((m) => m.kind === 'conflict').length,
  } : null;
  // The bulk choice for records CLOZR already has: the action every one of them carries, or null while mixed or unset.
  const existingIdx = review ? review.matches.flatMap((m, i) => (m.kind === 'existing' && !problems[i] ? [i] : [])) : [];
  const existingChoice = existingIdx.length && existingIdx.every((i) => actions[i] === actions[existingIdx[0]]) ? actions[existingIdx[0]] : null;
  const existingOpen = existingIdx.filter((i) => actions[i] == null).length;
  const conflictOpen = review ? review.matches.filter((m, i) => m.kind === 'conflict' && actions[i] == null && !problems[i]).length : 0;
  // At most this many COMPR reports, if switched on: the rows this import will create with an address.
  const comprMax = !runComprOnImport ? 0
    : kind === 'submissions' ? records.filter((r, i) => !r.problem && (r as ImportRecord).addr && review?.matches[i]?.kind !== 'existing').length
      : comprCandidates(kind, records, actions);

  const previewWin = rowWindow(previewScroll, records.length, 33, 360);
  const dupWin = rowWindow(dupScroll, dupRows.length, 64, 420);

  async function runSubmissions() {
    if (!wsId) return;
    setResult(null);
    setProgress({ done: 0, total: records.length });
    const out = await runSubmissionImport(wsId, s.user?.id ?? null, records as ImportRecord[], {
      label: sourceLabel.trim() || 'Import', vendorId: knownVendor?.id ?? null, vendorName, vendorType,
      owners: assignees, underwriter: underwriter || null, stage: subStage,
    }, (done) => setProgress({ done, total: records.length }));
    setProgress(null);
    setResult({ result: out.result, report: out.report, ids: [...out.dealIds, ...out.updatedDealIds].map((id) => 'sub:d' + id) });
    setReview(null);
    const confirmed = comprMax;
    setRunComprOnImport(false);
    if (confirmed && out.dealIds.length) {
      V.showToast(`COMPR queued for ${out.dealIds.length} submission${out.dealIds.length === 1 ? '' : 's'}`);
      void runComprMany(wsId, out.dealIds.slice(0, confirmed).map((dealId, k) => ({ sellerId: out.dealSellerIds[k], dealId })), (n, total) => { if (n === total || n % 10 === 0) V.showToast(`COMPR ${n}/${total}`); })
        .then((r) => { V.reloadCrm(); V.showToast(`COMPR done · ${r.ok} run${r.failed ? ` · ${r.failed} failed: ${r.firstError}` : ''}`); });
    }
    void lastImports(wsId).then(setLastRun);
    if (supabase) void supabase.from('vendors').select('id, business_name, service_type').eq('workspace_id', wsId).order('business_name').limit(2000)
      .then(({ data }) => setVendorList((data ?? []).map((v) => ({ id: v.id, name: v.business_name, type: v.service_type }))));
  }

  async function run() {
    if (!table || !wsId || !review) return;
    // Billed per report, so the count is confirmed before anything is written.
    if (comprMax && !window.confirm(comprConfirmText(comprMax))) return;
    pauseLive();
    try {
    if (kind === 'submissions') { await runSubmissions(); return; }
    setResult(null);
    setProgress({ done: 0, total: records.length });
    const out = await runImport(mapKind, wsId, s.user?.id ?? null, records, review, actions, {
      label: sourceLabel.trim() || 'Import',
      assignees, stage: stage || null, buyerStatus,
      tags: tagText.split(',').map((t) => t.trim()).filter(Boolean),
      planId, applyToUpdated, underwriter: underwriter || null, vendorType: vendorTypeAll || null,
    }, (done) => setProgress({ done, total: records.length }));
    setProgress(null);
    const prefix = mapKind === 'buyers' ? 'b' : mapKind === 'vendors' ? 'v' : 's';
    setResult({ ...out, ids: [...new Set(out.report.filter((r) => r.id != null && r.result !== 'skipped' && r.result !== 'error').map((r) => prefix + r.id))] });
    setReview(null);
    if (zeroIds.length) {
      const z = await resetLeaderboardReps(wsId, zeroIds);
      V.showToast(z.ok ? `Leaderboard zeroed for ${zeroIds.length} rep${zeroIds.length === 1 ? '' : 's'}` : (z.message ?? 'Could not zero the leaderboard'));
    }
    // COMPR only when switched on for this import, and never past the count confirmed above.
    const fresh = comprQueue(kind, out.report, records, comprMax);
    setRunComprOnImport(false);
    if (fresh.length) {
      V.showToast(`COMPR queued for ${fresh.length} new lead${fresh.length === 1 ? '' : 's'}`);
      void runComprMany(wsId, fresh, (n, total) => { if (n === total || n % 10 === 0) V.showToast(`COMPR ${n}/${total}`); })
        .then((r) => { V.reloadCrm(); V.showToast(`COMPR done · ${r.ok} run${r.failed ? ` · ${r.failed} failed: ${r.firstError}` : ''}`); });
    }
    void lastImports(wsId).then(setLastRun);
    } finally {
      resumeLive();
      V.reloadCrm();
    }
  }

  const listView = kind === 'buyers' ? V.goBuyers : kind === 'vendors' ? V.goVendorList : V.goPeople;
  // To exactly what this import wrote, not the whole list it landed in.
  const viewImported = () => (result?.ids.length ? V.openImported(kind, sourceLabel.trim() || 'Import', result.ids) : listView());
  const listName = kind === 'buyers' ? 'Buyers' : kind === 'vendors' ? 'Vendors' : 'People';
  const last = lastRun[sourceLabel.trim()];

  return (
    <section data-screen-label="Import" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: V.isMobile ? '14px' : '18px 22px', background: 'var(--canvas, #fafafa)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: 'var(--meta, #71717a)', marginBottom: '12px', flexWrap: 'wrap' }}>
        <button onClick={listView} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--meta, #71717a)', fontSize: '12.5px' }}>{listName}</button>
        <span>/</span>
        <span style={{ color: 'var(--ink, #18181b)', fontWeight: 600 }}>Import</span>
        <span style={{ flex: 1 }} />
        <div role="radiogroup" aria-label="What are you importing?" style={{ display: 'inline-flex', padding: '3px', background: 'var(--surface-2, #f4f4f5)', borderRadius: '10px', gap: '2px' }}>
          {kinds.map((k) => (
            <button key={k.key} role="radio" aria-checked={kind === k.key} onClick={() => setKind(k.key)} style={{ height: '28px', padding: '0 14px', border: 0, borderRadius: '8px', cursor: 'pointer', fontSize: '12.5px', fontWeight: 600, background: kind === k.key ? 'var(--surface, #fff)' : 'transparent', color: kind === k.key ? 'var(--ink, #18181b)' : 'var(--meta, #71717a)', boxShadow: kind === k.key ? '0 1px 2px rgba(0,0,0,.08)' : 'none' }}>
              {k.label}
            </button>
          ))}
        </div>
      </div>

      <ReadOnlyNote />
      {!live ? (
        <div style={{ ...card, background: 'var(--caution-soft, #fef3c7)', borderColor: 'var(--tint-amber-2, #fde68a)', color: 'var(--tx-amber-deep, #92400e)', fontSize: '12.5px' }}>
          This is the sample-data demo: loading and mapping work, but checking duplicates and importing need a signed-in workspace.
        </div>
      ) : null}

      <div style={card}>
        <h2 style={h2}>1 · Paste or upload {K.noun}</h2>
        <p style={sub}>
          {kind === 'submissions'
            ? 'The list a vendor sent (Offerpad, iFinder, Mark Spain…): one row per property. Each row becomes its own submission on that vendor, so 50 houses are 50 submissions under one vendor, never 50 vendors. '
            : ''}
          Upload the file as it came (Excel .xlsx or .xls, CSV, LibreOffice .ods), paste a Google Sheets link, or paste the rows straight from the sheet. Buyers map onto the profile and buy box (strategy, property type, price / beds / sqft / year, funding, DND). A DispoGenius CSV (customer_id, no_hoa, req_garage…) maps those columns automatically.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t.includes('\n')) { e.preventDefault(); setText(t); void load(t, null); } }}
          placeholder={'Name\tPhone\tEmail\n…'}
          rows={5}
          spellCheck={false}
          style={{ width: '100%', padding: '10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', fontSize: '12.5px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', background: 'var(--canvas, #fafafa)', color: 'var(--ink, #18181b)', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => void load(text, null)} disabled={!text.trim()} style={{ ...primary, opacity: text.trim() ? 1 : 0.5 }}>Read pasted table</button>
          <input ref={fileRef} type="file" onChange={(e) => void onFile(e)} style={{ display: 'none' }} />
          <button onClick={() => fileRef.current?.click()} disabled={!!reading} style={btn}>Upload file…</button>
          <button onClick={() => { setSheets([]); setText(SAMPLES[kind]); void load(SAMPLES[kind], 'Sample'); }} style={{ ...btn, color: 'var(--meta, #71717a)' }}>Try a sample</button>
          {fileName ? <span style={{ fontSize: '12px', color: 'var(--meta, #71717a)' }}>{fileName}</span> : null}
          {reading ? <span role="status" style={{ fontSize: '12px', color: 'var(--tx-mint, #0a8560)' }}>{reading}</span> : null}
        </div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void onSheetLink(); }}
            placeholder="https://docs.google.com/spreadsheets/d/…" aria-label="Google Sheets link"
            style={{ ...select, flex: '1 1 260px', height: '32px' }} />
          <button onClick={() => void onSheetLink()} disabled={!live || !sheetUrl.trim() || !!reading} title={live ? 'The sheet must be shared "Anyone with the link can view"' : 'Needs a signed-in workspace'}
            style={{ ...btn, opacity: live && sheetUrl.trim() && !reading ? 1 : 0.5 }}>Load Google Sheet</button>
          {sheets.length ? (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--meta, #71717a)' }}>Tab
              <select value={sheetName} onChange={(e) => pickSheet(e.target.value)} style={select}>
                {sheets.map((x) => <option key={x.sheet} value={x.sheet}>{x.sheet} ({Math.max(0, x.rows.length - 1)} rows)</option>)}
              </select>
            </label>
          ) : null}
        </div>
        {note ? <div role="status" style={{ marginTop: '10px', padding: '9px 11px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5, background: note.ok ? 'var(--positive-soft, #dcfce7)' : 'var(--negative-soft, #fee2e2)', border: `1px solid ${note.ok ? 'var(--tint-green-3, #bbf7d0)' : 'var(--tint-red-2, #fecaca)'}`, color: note.ok ? 'var(--tx-green, #15803d)' : '#b91c1c' }}>{note.text}</div> : null}
      </div>

      {table ? (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '200px' }}>
              <h2 style={h2}>2 · Map the columns</h2>
              <p style={{ ...sub, margin: 0 }}>
                Mapped from the headers and the values. Every column is listed: one with no CLOZR field is <strong>kept as extra info</strong> on the record (“More from import”), never dropped. Ask AI to remap anything not marked Sure; pick “Don’t import” only for a column you want left out.
              </p>
              <p data-testid="import-column-count" style={{ ...sub, margin: '4px 0 0', color: 'var(--muted, #52525b)' }}>
                {mapped.length} mapped to fields · {keptExtra} kept as extra info{leftOut ? ` · ${leftOut} left out` : ''}
              </p>
            </div>
            <button onClick={() => void askAi()} disabled={aiBusy || !live} title={live ? 'Claude remaps the uncertain columns and explains each guess' : 'Needs a signed-in workspace'} style={{ ...primary, opacity: aiBusy || !live ? 0.6 : 1 }}>{aiBusy ? 'Asking Claude…' : '✦ Ask AI to map'}</button>
            <button onClick={() => remap(table, kind)} style={btn}>Re-guess</button>
          </div>
          <div style={{ overflowX: 'auto', marginTop: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
              <thead>
                <tr><th style={th}>Source column</th><th style={th}>Sample values</th><th style={{ ...th, width: '260px' }}>CLOZR field</th></tr>
              </thead>
              <tbody>
                {table.headers.map((h, i) => {
                  const samples = table.rows.slice(0, 3).map((r) => r[i]).filter(Boolean);
                  const t = mapping[i] ?? 'skip';
                  const c = CONF[t === 'skip' || t === 'extra' ? t : conf[i] ?? 'medium'];
                  return (
                    <tr key={i} style={{ opacity: t === 'skip' ? 0.65 : 1 }}>
                      <td style={{ ...td, fontWeight: 600 }}>{h || <em style={{ color: 'var(--subtle, #a1a1aa)' }}>column {i + 1}</em>}</td>
                      <td style={{ ...td, maxWidth: '320px', whiteSpace: 'normal' }}>
                        <div style={mono}>{samples.join(' · ') || <span style={{ color: 'var(--subtle, #a1a1aa)' }}>empty</span>}</div>
                        {reasons[i] ? <div style={{ fontSize: '11px', color: 'var(--tx-mint, #0a8560)', marginTop: '2px' }}>✦ {reasons[i]}</div> : null}
                      </td>
                      <td style={{ ...td, maxWidth: 'none' }}>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          <select value={t} onChange={(e) => { setMapping((m) => ({ ...m, [i]: e.target.value as Target })); setConf((x) => ({ ...x, [i]: 'high' })); setReview(null); }} style={select}>
                            {grouped.map(([group, items]) => group
                              ? <optgroup key={group} label={group}>{items.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>
                              : items.map((x) => <option key={x.key} value={x.key}>{x.label}</option>))}
                          </select>
                          <span style={{ fontSize: '10.5px', fontWeight: 700, padding: '2px 6px', borderRadius: '6px', background: c.bg, color: c.fg }}>{c.text}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {table ? (
        <div style={card}>
          <h2 style={h2}>3 · Preview</h2>
          <p style={sub}>
            Values as CLOZR will store them — phones as +1…, names and addresses split, money and dates parsed. {importable.toLocaleString()} of {records.length.toLocaleString()} rows are usable
            {records.length - importable ? `; ${(records.length - importable).toLocaleString()} have nothing to create a record from` : ''}.
          </p>
          {!hasIdentity ? <div style={{ padding: '9px 11px', borderRadius: '9px', fontSize: '12.5px', background: 'var(--caution-soft, #fef3c7)', border: '1px solid var(--tint-amber-2, #fde68a)', color: 'var(--tx-amber-deep, #92400e)', marginBottom: '10px' }}>Map at least {K.identityHint}, or there is nothing to create a record from.</div> : null}
          <div ref={previewBox} onScroll={(e) => setPreviewScroll(e.currentTarget.scrollTop)} style={{ overflow: 'auto', maxHeight: '360px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead><tr>{[...PREVIEW_COLS[mapKind], ''].map((c, i) => <th key={c || i} style={stickyTh}>{c}</th>)}</tr></thead>
              <tbody>
                {previewWin.padTop ? <tr style={{ height: previewWin.padTop }} aria-hidden="true"><td colSpan={PREVIEW_COLS[mapKind].length + 1} /></tr> : null}
                {records.slice(previewWin.start, previewWin.end).map((r, k) => {
                  const i = previewWin.start + k;
                  return (
                  <tr key={i} style={{ color: r.problem ? 'var(--subtle, #a1a1aa)' : 'var(--ink, #18181b)', height: '33px' }}>
                    {previewCells(mapKind, r).map((v, j) => <td key={j} style={td} title={v || undefined}>{v || '—'}</td>)}
                    <td style={{ ...td, color: 'var(--tx-red, #b91c1c)', fontSize: '11px' }}>{r.problem ?? ''}</td>
                  </tr>
                  );
                })}
                {previewWin.padBottom ? <tr style={{ height: previewWin.padBottom }} aria-hidden="true"><td colSpan={PREVIEW_COLS[mapKind].length + 1} /></tr> : null}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '12px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--meta, #71717a)' }}>Nothing is written until you have reviewed duplicates.</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => void checkDuplicates()} disabled={!live || !importable || !hasIdentity || !!checking} style={{ ...primary, opacity: live && importable && hasIdentity && !checking ? 1 : 0.5 }}>
              {checking ?? (review ? 'Check again' : 'Check for duplicates')}
            </button>
          </div>
        </div>
      ) : (
        <Empty compact title="Nothing loaded yet" hint="Paste a table above, upload a CSV, or try the sample to see how mapping works." />
      )}

      {review && summary && counts ? (
        <div style={card}>
          <h2 style={h2}>4 · Duplicates</h2>
          <p style={sub}>{kind === 'submissions'
            ? 'Each row is a submission on the vendor below. The vendor itself is found by name or created once. A house that vendor already sent (the same row ID, or the same property address) is not made twice: the file fills in what its deal is missing, and COMPR is not pulled for it again.'
            : `Matched on ${kind === 'sellers' ? 'record ID, phone, email and property address' : kind === 'buyers' ? 'record ID, phone and email' : 'phone and email'}, inside this file and against CLOZR. A duplicate is never created, and a record CLOZR already has is only changed the way you choose.`}</p>
          {counts.existing && kind !== 'submissions' ? (
            <div role="group" aria-label="Records already in CLOZR" style={{ padding: '12px 14px', borderRadius: '10px', marginBottom: '12px', background: existingOpen ? '#fff7ed' : '#f8fafc', border: `1px solid ${existingOpen ? '#fdba74' : 'var(--divider, #e4e4e7)'}` }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--ink, #18181b)' }}>
                {counts.existing.toLocaleString()} {counts.existing === 1 ? 'record already exists' : 'records already exist'} in CLOZR. What should this file do to {counts.existing === 1 ? 'it' : 'them'}?
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '9px 0 7px' }}>
                {EXISTING_CHOICES.map(({ a, label: l }) => {
                  const on = existingChoice === a;
                  return (
                    <button key={a} type="button" aria-pressed={on} onClick={() => setAll((m) => m.kind === 'existing', a)}
                      style={{ ...btn, background: on ? 'var(--ink, #18181b)' : 'var(--surface, #fff)', borderColor: on ? 'var(--ink, #18181b)' : 'var(--line, #d4d4d8)', color: on ? 'var(--surface, #fff)' : 'var(--ink, #18181b)' }}>
                      {on ? '✓ ' : ''}{counts.existing === 1 ? l.replace('them', 'it') : l}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--muted, #52525b)', lineHeight: 1.5 }}>
                <strong>Add new info</strong> fills only their empty fields (mailing address, owner 2, property facts, extra columns included), adds tags, other phones and emails, and appends notes. <strong>Override</strong> writes every value this file has over theirs, never a blank (tags, phones, emails and notes are still added to, never replaced). <strong>Skip</strong> leaves them as they are.
                {kind === 'sellers' ? ' Add and Override also put the row’s ARV, rehab, offer and photos on the seller’s open deal by the same rule, and open a deal for a seller who has none.' : ''}
                {existingOpen
                  ? <span style={{ display: 'block', marginTop: '4px', color: 'var(--tx-orange, #c2410c)', fontWeight: 600 }}>Choose one to continue{existingChoice == null && existingOpen < counts.existing ? ` — ${existingOpen.toLocaleString()} still have no choice` : ''}. Single rows can still be changed below.</span>
                  : existingChoice == null ? <span style={{ display: 'block', marginTop: '4px' }}>Mixed: set row by row below.</span> : null}
              </div>
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {[
              ['New', summary.create, 'var(--mint-dim, #e7f8f1)', '#0A8560'],
              ['Skipped', summary.skipped, 'var(--surface-2, #f4f4f5)', 'var(--muted, #52525b)'],
              [kind === 'submissions' ? 'already in CLOZR (updated)' : 'Updates', summary.updates, 'var(--tint-blue, #eff6ff)', '#1d4ed8'],
              ...(kind === 'sellers' ? [['Co-sellers', summary.cosellers, '#f5f3ff', '#6d28d9']] : []),
              ['Need a choice', summary.unresolved, summary.unresolved ? 'var(--negative-soft, #fee2e2)' : 'var(--surface-2, #f4f4f5)', summary.unresolved ? '#b91c1c' : 'var(--muted, #52525b)'],
            ].map(([l, n, bg, fg]) => (
              <span key={l as string} style={{ padding: '6px 10px', borderRadius: '9px', background: bg as string, color: fg as string, fontSize: '12.5px', fontWeight: 600 }}>{(n as number).toLocaleString()} {l}</span>
            ))}
          </div>
          {dupRows.length && kind !== 'submissions' ? (
            <>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', fontSize: '12px', color: 'var(--meta, #71717a)', marginBottom: '8px' }}>
                {counts.file ? (<>
                  <span>All {counts.file} repeated in file:</span>
                  {(['skip', 'merge'] as Action[]).map((a) => <button key={a} onClick={() => setAll((m) => m.kind === 'file', a)} style={{ ...btn, height: '26px', fontSize: '11.5px' }}>{ACTION_LABEL[a]}</button>)}
                </>) : null}
                {counts.conflict ? (<>
                  <span style={{ marginLeft: '6px' }}>All {counts.conflict} address conflicts:</span>
                  {(['skip', 'coseller', 'fill'] as Action[]).map((a) => <button key={a} onClick={() => setAll((m) => m.kind === 'conflict', a)} style={{ ...btn, height: '26px', fontSize: '11.5px' }}>{a === 'fill' ? 'Add new info to existing' : ACTION_LABEL[a]}</button>)}
                </>) : null}
              </div>
              {last ? (
                <div style={{ fontSize: '12px', color: 'var(--tx-blue, #1d4ed8)', background: 'var(--tint-blue, #eff6ff)', border: '1px solid #bfdbfe', borderRadius: '9px', padding: '8px 10px', marginBottom: '8px' }}>
                  &ldquo;{sourceLabel}&rdquo; was last imported {new Date(last).toLocaleString()}. To sync it, choose Add new info or Override for the records already in CLOZR.
                </div>
              ) : null}
              <div ref={dupBox} onScroll={(e) => setDupScroll(e.currentTarget.scrollTop)} style={{ overflow: 'auto', maxHeight: '420px', border: '1px solid var(--divider-2, #f0f0f1)', borderRadius: '9px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead><tr><th style={stickyTh}>Row</th><th style={stickyTh}>In the file</th><th style={stickyTh}>Matches</th><th style={stickyTh}>Why</th><th style={stickyTh}>Do</th></tr></thead>
                  <tbody>
                    {dupWin.padTop ? <tr style={{ height: dupWin.padTop }} aria-hidden="true"><td colSpan={5} /></tr> : null}
                    {dupRows.slice(dupWin.start, dupWin.end).map(({ m, i }) => {
                      const cells = previewCells(mapKind, records[i]).filter(Boolean).slice(0, 4);
                      const other = m.kind === 'file' ? previewCells(mapKind, records[m.row]).filter(Boolean).slice(0, 4) : m.kind !== 'new' ? review.existing[m.id]?.show.filter(Boolean).slice(0, 4) ?? [] : [];
                      const a = actions[i];
                      return (
                        <tr key={i} style={{ background: a == null ? '#fff7f7' : undefined, height: '64px' }}>
                          <td style={td}>{i + 1}</td>
                          <td style={{ ...td, whiteSpace: 'normal', minWidth: '180px' }}><strong>{cells[0]}</strong><div style={mono}>{cells.slice(1).join(' · ')}</div></td>
                          <td style={{ ...td, whiteSpace: 'normal', minWidth: '180px' }}><strong>{other[0]}</strong><div style={mono}>{other.slice(1).join(' · ')}</div></td>
                          <td style={{ ...td, whiteSpace: 'normal', color: m.kind === 'conflict' ? '#b91c1c' : 'var(--muted, #52525b)', fontWeight: m.kind === 'conflict' ? 600 : 400 }}>{matchText(m)}</td>
                          <td style={{ ...td, maxWidth: 'none' }}>
                            <select aria-label={`What to do with row ${i + 1}`} value={a ?? ''} onChange={(e) => { const v = e.target.value as Action; setActions((cur) => cur.map((x, k) => (k === i ? v : x))); }} style={{ ...select, borderColor: a == null ? '#fca5a5' : 'var(--divider, #e4e4e7)' }}>
                              {a == null ? <option value="">Choose…</option> : null}
                              {actionsFor(m).map((x) => <option key={x} value={x}>{m.kind === 'conflict' && x === 'fill' ? 'Add new info to existing seller' : ACTION_LABEL[x]}</option>)}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                    {dupWin.padBottom ? <tr style={{ height: dupWin.padBottom }} aria-hidden="true"><td colSpan={5} /></tr> : null}
                  </tbody>
                </table>
              </div>
            </>
          ) : kind === 'submissions' && summary.updates
            ? <div style={{ fontSize: '12.5px', color: 'var(--tx-blue, #1d4ed8)' }}>{submissionCounts(summary.create, summary.updates)}: those fill in the deal CLOZR already has, never a second one.</div>
            : <div style={{ fontSize: '12.5px', color: 'var(--tx-mint, #0a8560)' }}>No duplicates — every usable row is new.</div>}
        </div>
      ) : null}

      {review || result ? (
        <div style={card}>
          <h2 style={h2}>5 · Assign and import</h2>
          <p style={sub}>Applied to new records{applyToUpdated ? ' and to records the import updates' : ''}.</p>
          <div style={{ display: 'grid', gridTemplateColumns: V.isMobile ? '1fr' : 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
            {kind === 'submissions' ? (
              <label style={label}>{partners.names.length ? 'Fallback vendor' : 'Vendor that sent the list'}
                <input list="import-vendors" value={vendorName} onChange={(e) => chooseVendor(e.target.value)} placeholder="Offerpad" style={select} aria-label="Vendor" />
                <datalist id="import-vendors">{vendorList.map((v) => <option key={v.id} value={v.name}>{v.type ?? ''}</option>)}</datalist>
                <span style={{ fontWeight: 400 }}>{partners.names.length > 1 || (partners.names.length === 1 && partners.names[0].toLowerCase() !== vendorName.trim().toLowerCase())
                  ? `The file names ${partners.names.length === 1 ? partners.names[0] : `${partners.names.length} partners`} under Submitted by: each row goes to its own vendor${partners.everyRow ? '' : ', rows without one to this vendor'}`
                  : vendorMissing ? 'Required' : knownVendor ? `Existing vendor${knownVendor.type ? ` · ${knownVendor.type}` : ''}` : 'New vendor, created once'}</span>
              </label>
            ) : null}
            {kind === 'submissions' ? (
              <label style={label}>Vendor type
                <select value={vendorType} onChange={(e) => setVendorType(e.target.value)} style={select}>
                  {SUBMITTER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <span style={{ fontWeight: 400 }}>{knownVendor && knownVendor.type && knownVendor.type !== vendorType ? `Changes ${knownVendor.name} from ${knownVendor.type}` : 'Which People list the vendor sits on'}</span>
              </label>
            ) : null}
            {kind === 'submissions' ? (
              <label style={label}>Stage
                <select value={subStage} onChange={(e) => setSubStage(e.target.value)} style={select}>
                  {PODIO_SUBMISSION_STAGES.map((st) => <option key={st} value={st}>{st}</option>)}
                  <optgroup label="Every stage">{SELLER_STAGES.filter((st) => !(PODIO_SUBMISSION_STAGES as readonly string[]).includes(st.label)).map((st) => <option key={st.label} value={st.label}>{st.label}</option>)}</optgroup>
                </select>
              </label>
            ) : null}
            {kind === 'vendors' ? (
              <label style={label}>Vendor type
                <select value={vendorTypeAll} onChange={(e) => setVendorTypeAll(e.target.value)} style={select}>
                  <option value="">From the file</option>
                  {VENDOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <span style={{ fontWeight: 400 }}>{vendorTypeAll ? `Every row is a ${vendorTypeAll}` : 'Each row keeps its service type column'}</span>
              </label>
            ) : null}
            {kind === 'sellers' || kind === 'submissions' ? (
              <div style={label}>
                Assign to {assignees.length > 1 ? '(round-robin)' : ''}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', fontWeight: 400 }}>
                  {team.length ? team.map((t) => {
                    const on = assignees.includes(t.id);
                    return <button key={t.id} onClick={() => setAssignees((a) => (on ? a.filter((x) => x !== t.id) : [...a, t.id]))} style={{ ...btn, height: '28px', fontSize: '12px', background: on ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', borderColor: on ? '#A8ECD2' : 'var(--divider, #e4e4e7)', color: on ? 'var(--tx-mint, #0a8560)' : 'var(--ink, #18181b)' }}>{on ? '✓ ' : ''}{t.name}</button>;
                  }) : <span style={{ color: 'var(--subtle, #a1a1aa)' }}>No teammates</span>}
                </div>
                <span style={{ fontWeight: 400 }}>{assignees.length === 0 ? 'Unassigned' : assignees.length === 1 ? 'All to one teammate' : `Rotates across ${assignees.length} teammates`}</span>
              </div>
            ) : null}
            {kind === 'sellers' || kind === 'submissions' ? (
              <label style={label}>Underwriter
                <select value={underwriter} onChange={(e) => setUnderwriter(e.target.value)} style={select} aria-label="Who underwrites these deals">
                  <option value="same">Same as the assigned rep</option>
                  <option value="">Nobody for now</option>
                  {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <span style={{ fontWeight: 400 }}>
                  {underwriter === 'same'
                    ? (assignees.length > 1 ? `Each ${kind === 'submissions' ? 'house' : 'lead'}’s underwriter rotates with its rep` : assignees.length ? 'The assigned rep underwrites' : 'Pick an assignee, or a name here')
                    : underwriter ? `${team.find((t) => t.id === underwriter)?.name ?? 'They'} underwrites every ${kind === 'submissions' ? 'house and is notified' : 'lead'}` : 'No underwriter set'}
                </span>
              </label>
            ) : null}
            {kind === 'sellers' ? (
              <label style={label}>Lead stage
                <select value={stage} onChange={(e) => setStage(e.target.value)} style={select}>
                  <option value="">From the file (or New Lead)</option>
                  {SELLER_STAGES.map((st) => <option key={st.label} value={st.label}>{st.label}</option>)}
                </select>
              </label>
            ) : null}
            {kind === 'buyers' ? (
              <label style={label}>Buyer stage
                <select value={buyerStatus} onChange={(e) => setBuyerStatus(e.target.value)} style={select}>
                  {BUYER_STAGES.map((st) => <option key={st} value={st}>{st}</option>)}
                </select>
              </label>
            ) : null}
            {kind === 'sellers' || kind === 'buyers' ? (
              <label style={label}>Tags (comma-separated)
                <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="probate, june list" style={select} />
              </label>
            ) : null}
            <label style={label}>Source label
              <input value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} style={select} />
              <span style={{ fontWeight: 400 }}>{last ? `Last imported ${new Date(last).toLocaleDateString()}` : 'Not imported before'}</span>
            </label>
            {kind === 'sellers' ? (
              <label style={label}>Action plan for new sellers
                <select value={planId ?? ''} onChange={(e) => setPlanId(e.target.value ? Number(e.target.value) : null)} style={select}>
                  <option value="">None</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            ) : null}
          </div>
          {kind === 'sellers' || kind === 'submissions' ? (
            <div data-testid="import-compr" style={{ marginTop: '12px', padding: '11px 13px', borderRadius: '10px', background: runComprOnImport ? 'var(--tint-amber, #fffbeb)' : 'var(--canvas, #fafafa)', border: `1px solid ${runComprOnImport ? '#fcd34d' : 'var(--divider, #e4e4e7)'}` }}>
              <label style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', fontWeight: 650, color: 'var(--ink, #18181b)', cursor: 'pointer' }}>
                <input type="checkbox" checked={runComprOnImport} onChange={(e) => setRunComprOnImport(e.target.checked)} />
                Pull a COMPR report for each new {kind === 'submissions' ? 'submission' : 'lead'}
              </label>
              <div style={{ fontSize: '12px', color: runComprOnImport ? 'var(--tx-amber-deep, #92400e)' : 'var(--meta, #71717a)', marginTop: '4px', lineHeight: 1.5 }}>
                {runComprOnImport
                  ? (comprMax
                    ? <>Up to <strong>{comprMax.toLocaleString()} COMPR report{comprMax === 1 ? '' : 's'}</strong>, one per new {kind === 'submissions' ? 'submission' : 'lead'} with an address. <strong>Each report is billed.</strong> You confirm the count before the import starts; records it updates are never underwritten.</>
                    : <>Nothing new in this import has an address, so no COMPR report would run.</>)
                  : <>Off — this import pulls no COMPR reports. Each report is billed, so turn it on only if you want every new {kind === 'submissions' ? 'submission' : 'lead'} underwritten.</>}
              </div>
            </div>
          ) : (
            <div data-testid="import-compr" style={{ marginTop: '12px', fontSize: '12px', color: 'var(--meta, #71717a)' }}>
              COMPR reports are not pulled for {kind}: nothing in this import is billed.
            </div>
          )}
          {isAdmin((s.workspace?.role as Role | undefined) ?? null) && team.length ? (
            <div style={{ marginTop: '12px' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 650, color: 'var(--ink-2, #27272a)' }}>Zero on the leaderboard</div>
              <p style={{ margin: '4px 0 8px', fontSize: '12px', color: 'var(--meta, #71717a)' }}>After this import, ignore older activity for the reps you pick so a big list does not skew calls, offers, or leads. The records stay.</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {team.map((t) => {
                  const on = zeroIds.includes(t.id);
                  return <button key={t.id} type="button" onClick={() => setZeroIds((ids) => on ? ids.filter((x) => x !== t.id) : [...ids, t.id])} style={{ ...btn, height: '28px', fontSize: '12px', background: on ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', borderColor: on ? '#A8ECD2' : 'var(--divider, #e4e4e7)', color: on ? 'var(--tx-mint, #0a8560)' : 'var(--ink, #18181b)' }}>{on ? '✓ ' : ''}{t.name}</button>;
                })}
              </div>
            </div>
          ) : null}
          {kind === 'sellers' || kind === 'buyers' ? (
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12.5px', color: 'var(--ink-2, #27272a)', marginTop: '10px' }}>
              <input type="checkbox" checked={applyToUpdated} onChange={(e) => setApplyToUpdated(e.target.checked)} />
              Also apply {kind === 'sellers' ? 'assignment, stage, tags and plan' : 'tags'} to records that get updated
            </label>
          ) : null}
          {review && summary ? (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '12px', flexWrap: 'wrap' }}>
              {summary.unresolved ? (
                <span style={{ fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)', fontWeight: 600 }}>
                  {[
                    existingOpen ? `${existingOpen.toLocaleString()} record${existingOpen === 1 ? '' : 's'} already in CLOZR` : '',
                    conflictOpen ? `${conflictOpen.toLocaleString()} address conflict${conflictOpen === 1 ? '' : 's'}` : '',
                  ].filter(Boolean).join(' and ') || `${summary.unresolved} rows`} need{existingOpen + conflictOpen === 1 ? 's' : ''} a choice above.
                </span>
              ) : null}
              <span style={{ flex: 1 }} />
              <button onClick={() => void run()} disabled={!!summary.unresolved || !!progress || !(summary.create + summary.updates + summary.cosellers) || vendorMissing} style={{ ...primary, opacity: !summary.unresolved && !progress && summary.create + summary.updates + summary.cosellers && !vendorMissing ? 1 : 0.5 }}>
                {progress ? `Importing ${progress.done} / ${progress.total}…`
                  : kind === 'submissions' ? `Import ${summary.create} submission${summary.create === 1 ? '' : 's'}${summary.updates ? `, update ${summary.updates} already in CLOZR` : ''}${partners.names.length > 1 ? ` from ${partners.names.length} partners` : vendorName.trim() ? ` from ${vendorName.trim()}` : partners.names[0] ? ` from ${partners.names[0]}` : ''}${comprMax ? ` · then up to ${comprMax} COMPR` : ''}`
                    : `Import: ${summary.create} new, ${summary.updates} updates${summary.cosellers ? `, ${summary.cosellers} co-sellers` : ''}${comprMax ? ` · then up to ${comprMax} COMPR` : ''}`}
              </button>
            </div>
          ) : null}
          {result ? (
            <div style={{ marginTop: '12px', padding: '11px 12px', borderRadius: '10px', background: 'var(--mint-dim, #e7f8f1)', border: '1px solid #A8ECD2', fontSize: '12.5px', color: 'var(--tx-mint, #0a8560)', lineHeight: 1.6 }}>
              {kind === 'submissions' ? <strong>{submissionCounts(result.result.created, result.result.updated)}</strong> : <><strong>{result.result.created.toLocaleString()} created</strong> · {result.result.updated.toLocaleString()} updated</>}{result.result.cosellers ? ` · ${result.result.cosellers} co-sellers` : ''} · {result.result.skipped.toLocaleString()} skipped{result.result.errors.length ? ` · ${result.result.errors.length} failed` : ''}.
              {result.result.errors.length ? <div style={{ color: 'var(--tx-red, #b91c1c)', marginTop: '4px' }}>{result.result.errors.slice(0, 5).join(' · ')}{result.result.errors.length > 5 ? ` · +${result.result.errors.length - 5} more` : ''}</div> : null}
              <div style={{ marginTop: '6px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button onClick={viewImported} style={primary}>Go to my import ({result.ids.length.toLocaleString()} {K.noun})</button>
                <button onClick={() => download(`${(sourceLabel || 'import').replace(/[^\w.-]+/g, '_')}-report.csv`, importReportCsv(result.report))} style={btn}>Download report (CSV)</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
