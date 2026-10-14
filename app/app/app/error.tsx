'use client';

// The app's own error page, for anything the screen boundary does not catch:
// a throw in the view model, the shell, or the session plumbing above them.
//
// Replaces the framework's blank "This page couldn't load", which named neither
// the error nor a way out. Reset re-renders the route in place; Home is a full
// navigation, because the state that caused the throw is exactly what a reset
// would keep.

import React, { useEffect } from 'react';
import { Crash } from '@/components/ds/Crash';
import { reportClientError } from '@/lib/client-errors';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[clozr] app threw', error);
    reportClientError(error, { kind: 'app', where: error.digest ? `app (digest ${error.digest})` : 'app' });
  }, [error]);
  return (
    <Crash
      full
      error={error}
      onRetry={reset}
      // A full load on purpose: the router is what may have thrown, and the
      // state a client-side navigation would keep is the state that broke.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      onHome={() => window.location.assign('/app')}
    />
  );
}
