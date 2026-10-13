// State for the action-plan builder: the list, the plan being edited, who is
// on it, and the AI conversation about it. Self-contained — it reads the
// workspace and the signed-in user from the session and talks to Supabase
// directly, so the screens can be built without touching the view-model.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/lib/session';
import { enrollInPlan } from '@/lib/crm-write';
import { applyPlanPlayback } from '@/lib/plan-hold';
import {
  type AiPlan, type EnrolledRow, type PlanDraft, type PlanStepDraft, type PlanSummary, type SellerPick, type StepType, type Teammate,
  aiFromDraft, blankPlan, blankStep, catalogPreviewDraft, catalogPreviewPlans, deletePlanById, diffDrafts, draftFromAi, duplicateDraft, ensureCatalogPlans, lastPlan, listEnrolled, listPlans,
  listSellerPicks, listTeammates, loadPlan, pauseEnrollment, rememberPlan, resumeEnrollment, sameDraft, savePlanDraft, setPlanActive, stopEnrollment, triggerLabel,
} from '@/lib/plans';
import { askPlanAi } from '@/lib/plans-ai';

export type AiReview = { kind: 'goal' | 'edit'; changes: string[]; before: PlanDraft | null };

/** Sample people on the first catalog plan, so play and pause can be tried with no workspace. */
const PREVIEW_PLAN_ID = 1;
const PREVIEW_ENROLLED: EnrolledRow[] = [
  { id: 101, seller_id: 2, name: 'Ronald Moore', addr: '1803 Cypress Lane', status: 'active', step: 2, total: 4, enrolled_at: '2026-09-20T15:00:00.000Z', stopped_reason: null },
  { id: 102, seller_id: 1, name: 'Kara Mitchell', addr: '123 Oakview Drive', status: 'paused', step: 6, total: 8, enrolled_at: '2026-08-22T14:00:00.000Z', stopped_reason: 'manual' },
];

export function usePlans(opts: { onSaved?: () => void; notify?: (msg: string) => void } = {}) {
  const session = useSession();
  const workspaceId = session.workspace?.id ?? null;
  const userId = session.user?.id ?? null;
  const canWrite = workspaceId !== null;
  const preview = workspaceId === null;
  const [previewPeople, setPreviewPeople] = useState<EnrolledRow[]>(PREVIEW_ENROLLED);

  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [saved, setSaved] = useState<PlanDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [enrolled, setEnrolled] = useState<EnrolledRow[]>([]);
  const [sellers, setSellers] = useState<SellerPick[]>([]);
  const [team, setTeam] = useState<Teammate[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiReview, setAiReview] = useState<AiReview | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notifyRef = useRef(opts.notify);
  const onSavedRef = useRef(opts.onSaved);
  useEffect(() => { notifyRef.current = opts.notify; onSavedRef.current = opts.onSaved; });

  const toast = useCallback((msg: string) => {
    if (notifyRef.current) return notifyRef.current(msg);
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
  }, []);

  const dirty = useMemo(() => !!draft && (!saved || !sameDraft(draft, saved)), [draft, saved]);

  // ---- loading --------------------------------------------------------------------

  const refreshList = useCallback(async () => {
    if (workspaceId === null) {
      setPlans(catalogPreviewPlans().map((p) => (p.id === PREVIEW_PLAN_ID ? { ...p, enrolled_count: PREVIEW_ENROLLED.length } : p)));
      setLoadError(null);
      setLoading(false);
      return;
    }
    await ensureCatalogPlans(workspaceId, userId);
    const r = await listPlans(workspaceId);
    if (!r.ok) setLoadError(r.message ?? 'Could not load plans.');
    else { setLoadError(null); setPlans(r.plans); }
    setLoading(false);
  }, [workspaceId, userId]);

  const refreshEnrolled = useCallback(async (planId: number | null) => {
    if (workspaceId === null) {
      setEnrolled(planId === PREVIEW_PLAN_ID ? previewPeople : []);
      return;
    }
    setEnrolled(planId ? await listEnrolled(planId) : []);
  }, [workspaceId, previewPeople]);

  useEffect(() => {
    if (!session.ready) return;
    let alive = true;
    // Everything lands in .then callbacks: the effect itself sets no state.
    void Promise.resolve().then(() => refreshList());
    if (workspaceId !== null) {
      void listSellerPicks(workspaceId).then((rows) => { if (alive) setSellers(rows); });
      void listTeammates(workspaceId).then((rows) => { if (alive) setTeam(rows); });
    }
    return () => { alive = false; };
  }, [session.ready, workspaceId, refreshList]);

  const open = useCallback(async (planId: number) => {
    if (workspaceId === null) {
      const plan = catalogPreviewDraft(planId);
      if (!plan) return toast('Could not open that plan.');
      const current = plans.find((p) => p.id === planId);
      if (current) plan.active = current.active;
      setDraft(plan);
      setSaved(plan);
      setAiReview(null);
      setEnrolled(planId === PREVIEW_PLAN_ID ? previewPeople : []);
      return;
    }
    const r = await loadPlan(planId);
    if (!r.ok || !r.plan) return toast(r.message ?? 'Could not open that plan.');
    setDraft(r.plan);
    setSaved(r.plan);
    setAiReview(null);
    rememberPlan(planId);
    void refreshEnrolled(planId);
  }, [toast, refreshEnrolled, workspaceId, previewPeople, plans]);

  // Reopen the plan the person was last on, once the list is in.
  const reopened = useRef(false);
  useEffect(() => {
    if (reopened.current || loading || draft) return;
    reopened.current = true;
    const last = lastPlan();
    if (last && plans.some((p) => p.id === last)) void Promise.resolve().then(() => open(last));
  }, [loading, plans, draft, open]);

  // Leaving with unsaved work asks first, the way a browser form does.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const confirmDiscard = useCallback(() =>
    !dirty || window.confirm('This plan has unsaved changes. Leave without saving?'), [dirty]);

  // ---- the list --------------------------------------------------------------------------

  const select = useCallback((planId: number) => {
    if (draft?.id === planId) return;
    if (!confirmDiscard()) return;
    void open(planId);
  }, [draft, confirmDiscard, open]);

  const newPlan = useCallback(() => {
    if (!confirmDiscard()) return;
    const p = blankPlan();
    setDraft(p);
    setSaved(null);
    setAiReview(null);
    setEnrolled([]);
    rememberPlan(null);
  }, [confirmDiscard]);

  const duplicate = useCallback(async (planId: number) => {
    if (!confirmDiscard()) return;
    const r = await loadPlan(planId);
    if (!r.ok || !r.plan) return toast(r.message ?? 'Could not copy that plan.');
    const copy = duplicateDraft(r.plan);
    setDraft(copy);
    setSaved(null);
    setAiReview(null);
    setEnrolled([]);
    rememberPlan(null);
    toast('Copied — edit it, then Save');
  }, [confirmDiscard, toast]);

  const remove = useCallback(async (planId: number) => {
    const p = plans.find((x) => x.id === planId);
    const who = p?.enrolled_count ? ` ${p.enrolled_count} enrolled seller${p.enrolled_count === 1 ? '' : 's'} come off it and their queued steps are removed.` : '';
    if (!window.confirm(`Delete "${p?.name ?? 'this plan'}"?${who}`)) return;
    const r = await deletePlanById(planId);
    if (!r.ok) return toast(r.message ?? 'Could not delete the plan.');
    if (draft?.id === planId) { setDraft(null); setSaved(null); setEnrolled([]); rememberPlan(null); }
    toast('Plan deleted');
    void refreshList();
    onSavedRef.current?.();
  }, [plans, draft, toast, refreshList]);

  const toggleActive = useCallback(async (planId: number, active: boolean) => {
    if (preview) {
      const applied = planId === PREVIEW_PLAN_ID ? applyPlanPlayback(previewPeople, active) : { rows: previewPeople, held: 0 };
      if (planId === PREVIEW_PLAN_ID) {
        setPreviewPeople(applied.rows);
        setEnrolled(applied.rows);
      }
      setPlans((ps) => ps.map((p) => (p.id === planId ? { ...p, active } : p)));
      if (draft?.id === planId) {
        setDraft((d) => (d ? { ...d, active } : d));
        setSaved((d) => (d ? { ...d, active } : d));
      }
      const n = applied.held;
      toast(active
        ? (n ? `Playing — ${n} picked back up` : 'Playing')
        : (n ? `Paused — ${n} held` : 'Paused'));
      return;
    }
    const r = await setPlanActive(planId, active);
    if (!r.ok) return toast(r.message ?? 'Could not change that.');
    setPlans((ps) => ps.map((p) => (p.id === planId ? { ...p, active } : p)));
    if (draft?.id === planId) {
      setDraft((d) => (d ? { ...d, active } : d));
      setSaved((d) => (d ? { ...d, active } : d));
    }
    const n = r.held ?? 0;
    toast(active
      ? (n ? `Playing — ${n} picked back up` : 'Playing')
      : (n ? `Paused — ${n} held` : 'Paused'));
    void refreshEnrolled(planId);
    onSavedRef.current?.();
  }, [draft, toast, refreshEnrolled, preview, previewPeople]);

  // ---- the editor --------------------------------------------------------------------

  const patch = useCallback((p: Partial<PlanDraft>) => setDraft((d) => (d ? { ...d, ...p } : d)), []);
  const patchSettings = useCallback((p: Partial<PlanDraft['settings']>) =>
    setDraft((d) => (d ? { ...d, settings: { ...d.settings, ...p } } : d)), []);
  const patchStep = useCallback((key: string, p: Partial<PlanStepDraft>) =>
    setDraft((d) => (d ? { ...d, steps: d.steps.map((s) => (s.key === key ? { ...s, ...p } : s)) } : d)), []);
  const addStep = useCallback((type: StepType, after?: string) =>
    setDraft((d) => {
      if (!d) return d;
      const st = blankStep(type);
      if (!after) return { ...d, steps: [...d.steps, st] };
      const i = d.steps.findIndex((s) => s.key === after);
      const steps = [...d.steps];
      steps.splice(i < 0 ? steps.length : i + 1, 0, st);
      return { ...d, steps };
    }), []);
  const removeStep = useCallback((key: string) =>
    setDraft((d) => (d ? { ...d, steps: d.steps.filter((s) => s.key !== key) } : d)), []);
  const duplicateStep = useCallback((key: string) =>
    setDraft((d) => {
      if (!d) return d;
      const i = d.steps.findIndex((s) => s.key === key);
      if (i < 0) return d;
      const steps = [...d.steps];
      steps.splice(i + 1, 0, { ...d.steps[i], key: blankStep().key });
      return { ...d, steps };
    }), []);
  const moveStep = useCallback((from: number, to: number) =>
    setDraft((d) => {
      if (!d || from === to || from < 0 || to < 0 || from >= d.steps.length || to >= d.steps.length) return d;
      const steps = [...d.steps];
      const [s] = steps.splice(from, 1);
      steps.splice(to, 0, s);
      return { ...d, steps };
    }), []);

  const save = useCallback(async () => {
    if (!draft) return;
    if (!canWrite || workspaceId === null) return toast('Sign in to a workspace to save plans');
    if (draft.trigger_type === 'stage' && !draft.trigger_value.trim()) return toast('Pick the stage that starts this plan');
    if (draft.trigger_type === 'tag' && !draft.trigger_value.trim()) return toast('Name the tag that starts this plan');
    setSaving(true);
    const r = await savePlanDraft(workspaceId, draft, userId);
    setSaving(false);
    if (!r.ok || !r.id) return toast(r.message ?? 'Could not save the plan.');
    const savedDraft = { ...draft, id: r.id, name: draft.name.trim() || 'Untitled plan' };
    setDraft(savedDraft);
    setSaved(savedDraft);
    setAiReview(null);
    rememberPlan(r.id);
    toast('Plan saved');
    void refreshList();
    void refreshEnrolled(r.id);
    onSavedRef.current?.();
  }, [draft, canWrite, workspaceId, userId, toast, refreshList, refreshEnrolled]);

  const cancel = useCallback(() => {
    if (!draft) return;
    if (!dirty) return;
    if (!window.confirm('Throw away the unsaved changes?')) return;
    if (saved) setDraft(saved);
    else { setDraft(null); rememberPlan(null); }
    setAiReview(null);
  }, [draft, dirty, saved]);

  const close = useCallback(() => {
    if (!confirmDiscard()) return;
    setDraft(null); setSaved(null); setAiReview(null); setEnrolled([]); rememberPlan(null);
  }, [confirmDiscard]);

  // ---- enrolment -----------------------------------------------------------------------

  const enroll = useCallback(async (sellerId: number) => {
    if (!draft?.id || workspaceId === null) return toast('Save the plan before enrolling anyone');
    const r = await enrollInPlan(workspaceId, 'ap' + draft.id, 's' + sellerId, userId);
    if (!r.ok) return toast(r.message ?? 'Could not enroll.');
    if (r.already) return toast('Already on this plan');
    toast(r.queued ? `Enrolled — ${r.queued} step${r.queued === 1 ? '' : 's'} queued as tasks` : 'Enrolled');
    void refreshEnrolled(draft.id);
    void refreshList();
    onSavedRef.current?.();
  }, [draft, workspaceId, userId, toast, refreshEnrolled, refreshList]);

  const pauseOne = useCallback(async (enrollmentId: number) => {
    if (preview) {
      const next = previewPeople.map((e) => (e.id === enrollmentId ? { ...e, status: 'paused', stopped_reason: 'manual' } : e));
      setPreviewPeople(next);
      setEnrolled(next);
      toast('Paused — open steps are held');
      return;
    }
    const r = await pauseEnrollment(enrollmentId, 'manual');
    if (!r.ok) return toast(r.message ?? 'Could not pause that.');
    toast('Paused — open steps are held');
    void refreshEnrolled(draft?.id ?? null);
    onSavedRef.current?.();
  }, [draft, toast, refreshEnrolled, preview, previewPeople]);

  const resumeOne = useCallback(async (enrollmentId: number) => {
    if (preview) {
      const row = previewPeople.find((e) => e.id === enrollmentId);
      if (!row || row.status !== 'paused') return toast('That plan is not paused.');
      const next = previewPeople.map((e) => (e.id === enrollmentId ? { ...e, status: 'active', stopped_reason: null } : e));
      setPreviewPeople(next);
      setEnrolled(next);
      toast('Playing');
      return;
    }
    const r = await resumeEnrollment(enrollmentId);
    if (!r.ok) return toast(r.message ?? 'Could not play that.');
    toast(r.queued ? `Playing — ${r.queued} step${r.queued === 1 ? '' : 's'} queued` : 'Playing');
    void refreshEnrolled(draft?.id ?? null);
    onSavedRef.current?.();
  }, [draft, toast, refreshEnrolled, preview, previewPeople]);

  const stop = useCallback(async (enrollmentId: number) => {
    if (preview) {
      const next = previewPeople.map((e) => (e.id === enrollmentId ? { ...e, status: 'done', stopped_reason: 'manual' } : e));
      setPreviewPeople(next);
      setEnrolled(next);
      setPlans((ps) => ps.map((p) => (p.id === PREVIEW_PLAN_ID ? { ...p, enrolled_count: next.filter((e) => e.status !== 'done').length } : p)));
      toast('Stopped — queued steps removed');
      return;
    }
    const r = await stopEnrollment(enrollmentId);
    if (!r.ok) return toast(r.message ?? 'Could not stop that.');
    toast('Stopped — queued steps removed');
    void refreshEnrolled(draft?.id ?? null);
    void refreshList();
    onSavedRef.current?.();
  }, [draft, toast, refreshEnrolled, refreshList]);

  // ---- the AI ---------------------------------------------------------------------------

  const aiGenerate = useCallback(async (goal: string, tone: string, stepCount: number | null) => {
    if (workspaceId === null) return toast('Sign in to a workspace to use AI drafting');
    const g = goal.trim();
    if (!g) return toast('Describe the plan you want first');
    setAiBusy(true);
    const base = draft ?? blankPlan();
    const r = await askPlanAi(workspaceId, { mode: 'goal', goal: g, tone: tone.trim() || undefined, stepCount, trigger: base.trigger_type !== 'manual' ? triggerLabel(base.trigger_type, base.trigger_value) : undefined });
    setAiBusy(false);
    if (!r.ok) return toast(r.message);
    const next = draftFromAi(r.plan, draft);
    if (tone.trim()) next.settings.tone = tone.trim();
    setDraft(next);
    if (!draft) setSaved(null);
    setAiReview({ kind: 'goal', changes: draft ? diffDrafts(draft, next) : [], before: draft });
    toast(`Drafted ${next.steps.length} steps — review, then Save`);
  }, [workspaceId, draft, toast]);

  const aiEdit = useCallback(async (instruction: string, tone: string) => {
    if (workspaceId === null) return toast('Sign in to a workspace to use AI editing');
    if (!draft) return toast('Open or create a plan first');
    const ins = instruction.trim();
    if (!ins) return toast('Say what to change');
    setAiBusy(true);
    const r = await askPlanAi(workspaceId, { mode: 'edit', plan: aiFromDraft(draft), instruction: ins, tone: tone.trim() || draft.settings.tone || undefined });
    setAiBusy(false);
    if (!r.ok) return toast(r.message);
    const next = draftFromAi(r.plan as AiPlan, draft);
    // Editing never changes what the plan is wired to; only the AI's words do.
    next.trigger_type = draft.trigger_type;
    next.trigger_value = draft.trigger_value;
    next.on_end_next_plan_id = draft.on_end_next_plan_id;
    next.on_complete = draft.on_complete;
    const changes = r.changes.length ? r.changes : diffDrafts(draft, next);
    setDraft(next);
    setAiReview({ kind: 'edit', changes, before: draft });
    toast('Revised — review the changes, then Save');
  }, [workspaceId, draft, toast]);

  const aiUndo = useCallback(() => {
    if (!aiReview?.before) { setDraft(saved); setAiReview(null); return; }
    setDraft(aiReview.before);
    setAiReview(null);
  }, [aiReview, saved]);

  const dismissReview = useCallback(() => setAiReview(null), []);

  const tags = useMemo(() => {
    const set = new Set<string>();
    sellers.forEach((s) => s.tags.forEach((t) => set.add(t)));
    return [...set].sort();
  }, [sellers]);

  return {
    workspaceId, userId, canWrite, preview, loading, loadError,
    plans, draft, saved, dirty, saving, enrolled, sellers, team, tags,
    aiBusy, aiReview, toastMsg,
    select, open, newPlan, duplicate, remove, toggleActive,
    patch, patchSettings, patchStep, addStep, removeStep, duplicateStep, moveStep,
    save, cancel, close, enroll, pauseOne, resumeOne, stop,
    aiGenerate, aiEdit, aiUndo, dismissReview, refreshList,
  };
}

export type PlansApi = ReturnType<typeof usePlans>;
