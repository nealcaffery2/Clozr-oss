// The Dialer: Talkr's desktop dialer page (app/components/talkr/DialerScreen),
// under `.talkr-dialer` tokens. The softphone behind it is CLOZR's own
// (useTalkrPhone), reached through app/components/talkr/softphoneAdapter.
//
// One layout since the 2026-10-18 redesign: the script in the centre, the
// record on the right. A switch in the title bar swaps the phone for the
// power dialer (components/talkr/PowerDialer.tsx), which runs lists on Talkr.
'use client';

import type { ClozrView } from '@/app/clozr/view';
import { DialerScreen } from '@/app/components/talkr/DialerScreen';
import { PowerDialerScreen } from '@/app/components/talkr/PowerDialer';
import { useDialerView } from '@/lib/dialer-view';
// Styles: talkr-dialer.css, loaded once by ClozrShell (see the note there).
import '@/app/clozr/dialer-desk.css';

export function Dialer({ V }: { V: ClozrView }) {
  // Phone or power dialer: the switch in the title bar, remembered per browser (lib/dialer-view.ts).
  const view = useDialerView();
  return (
    <section
      data-screen-label="Dialer"
      className="talkr-dialer"
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}
    >
      {view === 'phone' ? <DialerScreen V={V} /> : <PowerDialerScreen V={V} />}
    </section>
  );
}
