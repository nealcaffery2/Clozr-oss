// The Dialer: Talkr's desktop dialer page (app/components/talkr/DialerScreen),
// under `.talkr-dialer` tokens. The softphone behind it is CLOZR's own
// (useTalkrPhone), reached through app/components/talkr/softphoneAdapter.
//
// Two layouts, picked per user by Settings › Try new design: the classic
// dialer (DialerScreenClassic, the default) and the three-column desk.
'use client';

import type { ClozrView } from '@/app/clozr/view';
import { DialerScreen } from '@/app/components/talkr/DialerScreen';
import { DialerScreenClassic } from '@/app/components/talkr/DialerScreenClassic';
import '@/app/clozr/talkr-dialer.css';

export function Dialer({ V }: { V: ClozrView }) {
  return (
    <section
      data-screen-label="Dialer"
      data-design={V.newDesign ? 'new' : 'classic'}
      className="talkr-dialer"
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}
    >
      {V.newDesign ? <DialerScreen V={V} /> : <DialerScreenClassic V={V} />}
    </section>
  );
}
