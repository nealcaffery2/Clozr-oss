'use client';

// One screen failing must not take the whole app with it.
//
// Every screen is drawn inside the same shell, so before this an exception in
// the People table replaced the header, the nav and the dialer with a blank
// error page — and there was no way back but a reload, which brought the same
// screen and the same error straight back. Catching at the screen keeps the
// shell alive: the person can go to Home, keep taking calls, and read what
// actually went wrong.
//
// The boundary resets when the screen changes, so navigating away and back
// tries a fresh render rather than showing a stale failure.

import React from 'react';
import { Crash } from './Crash';

type Props = { screen: string; label?: string | null; onHome?: () => void; children: React.ReactNode };
type State = { error: unknown | null };

export class ScreenBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // The console is where the fix gets found; the card is where it gets noticed.
    console.error(`[clozr] screen "${this.props.screen}" threw`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.screen !== this.props.screen) this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return (
        <Crash
          error={this.state.error}
          where={this.props.label ?? this.props.screen}
          onRetry={() => this.setState({ error: null })}
          onHome={this.props.screen === 'home' ? undefined : this.props.onHome}
        />
      );
    }
    return this.props.children;
  }
}
