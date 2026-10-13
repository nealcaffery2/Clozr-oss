// CLOZR on sample data — the whole app, no account, nothing saved.
//
// This route exists because /app is now guarded. Until Supabase was wired up,
// /app *was* the demo: with no credentials there was nothing to sign in to, so
// the guard stood down and anyone could look around. Configuring the project
// turned that off, and "See it on sample data" would have bounced to the login
// page it was offering an alternative to.
//
// So the demo gets its own door. Same shell, same mock entity graph in
// lib/clozr-data.ts, no session required and no route guard. Live database is
// mounted here too, so its nav entry is not a dead end — it reads the real
// workspace, so to a visitor it says "sign in to open your list", which is the
// truth and is exactly the line between the demo and the product.
'use client';

import '../clozr/tokens.css';
import '../clozr/clozr.css';
import '../clozr/chrome.css';
import '../clozr/surfaces.css';

import { useSyncExternalStore } from 'react';
import { ClozrShell } from '../clozr/ClozrShell';
import { LiveLists } from '../clozr/LiveLists';
import { useClozr } from '../clozr/useClozr';
import type { Role } from '@/lib/team';
import { DEMO_ROLE, canSeeBuyers } from '@/lib/team';

/**
 * /demo?as=acquisitions (or dispositions, tc…) shows the sample graph with
 * that role's nav and landing, so they can be seen without an account. The
 * demo has no data behind it to widen; this only changes what is shown.
 * Read after hydration: the prerendered page has no query string.
 */
const ROLES: Role[] = ['owner', 'admin', 'acquisitions', 'dispositions', 'tc', 'notary', 'member'];
const AS = {
  subscribe: () => () => {},
  getSnapshot: (): string => {
    const r = new URLSearchParams(window.location.search).get('as') ?? '';
    return (ROLES as string[]).includes(r) ? r : '';
  },
  getServerSnapshot: (): string | null => null,
};

export default function DemoPage() {
  const as = useSyncExternalStore(AS.subscribe, AS.getSnapshot, AS.getServerSnapshot);
  // The address is restored once the role is known, so ?as= lands where that role lands.
  const V = useClozr({ role: (as || DEMO_ROLE) as Role, ready: as !== null });
  return (
    <ClozrShell V={V}>
      {V.isLiveLists && (
        <LiveLists
          section={V.liveSection}
          onSection={V.setLiveSection}
          onToast={V.showToast}
          onChanged={V.reloadCrm}
          canSeeBuyers={canSeeBuyers((as || DEMO_ROLE) as Role)}
        />
      )}
    </ClozrShell>
  );
}
