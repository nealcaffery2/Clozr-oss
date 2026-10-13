// The Dialer: Talkr's desktop dialer page (app/components/talkr/DialerScreen),
// under `.talkr-dialer` tokens. The softphone behind it is CLOZR's own
// (useTalkrPhone), reached through app/components/talkr/softphoneAdapter.
'use client';

import type { ClozrView } from '@/app/clozr/view';
import { DialerScreen } from '@/app/components/talkr/DialerScreen';
import '@/app/clozr/talkr-dialer.css';

export function Dialer({ V }: { V: ClozrView }) {
  return (
    <section
      data-screen-label="Dialer"
      className="talkr-dialer"
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}
    >
      <DialerScreen V={V} />
    </section>
  );
}
