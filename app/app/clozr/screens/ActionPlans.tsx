// Action plans — the list of follow-up sequences and the builder for one.
//
// The builder is self-contained (app/components/plans): it reads and writes
// action_plans / action_plan_steps / enrollments through Supabase directly
// and takes from the shell only what a screen needs — the mobile layout,
// the way back to where "Start action plan" came from, and the shell's toast,
// reload and person-opener where the view exposes them.
'use client';

import React, { useState } from 'react';
import { BackLink } from '@/components/ds/BackLink';
import type { ClozrView } from '@/app/clozr/view';
import { PlanBuilder } from '@/app/components/plans/PlanBuilder';
import { TextSequences } from '@/app/components/sequences/TextSequences';

const headBtn: React.CSSProperties = { height: '32px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12.5px', cursor: 'pointer', color: '#18181b' };

export function ActionPlans({ V }: { V: ClozrView }) {
  // Automated texts (Talkr sequences) sit beside action plans: plans make tasks
  // a rep works by hand, sequences send their texts themselves.
  const [texts, setTexts] = useState(false);
  if (texts) {
    return (
      <TextSequences headerLeft={
        <BackLink to={{ label: 'Action plans', go: () => setTexts(false) }} />
      } />
    );
  }
  return (
    <PlanBuilder
      isMobile={V.isMobile}
      notify={V.showToast}
      onChanged={V.reloadCrm}
      onOpenPerson={(id) => V.openPerson('s' + id)}
      // Opened from somewhere (a record's plan, People's bulk bar, a buyer): the way back there.
      headerLeft={V.planReturnTo ? (
        <BackLink to={V.planBack} />
      ) : null}
      headerRight={
        <>
        <button type="button" className="dc2" onClick={() => setTexts(true)} title="Talkr sequences: texts that send themselves and stop on a reply" style={headBtn}>
          Automated texts
        </button>
        <button type="button" className="dc2" onClick={V.goAutomations} style={{ height: '32px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12.5px', cursor: 'pointer', color: '#18181b' }}>
          Automation canvas
        </button>
        </>
      }
    />
  );
}
