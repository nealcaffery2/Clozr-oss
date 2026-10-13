// Placeholders for data that has not arrived. The shell stays up; the
// missing rows shimmer in place of a blank screen or a "Loading…" line.
'use client';

export function SkeletonRows({ count = 6, label = 'Loading' }: { count?: number; label?: string }) {
  return (
    <div className="clozr-skel-rows" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="clozr-skel-row">
          <span className="clozr-skel-avatar" />
          <span className="clozr-skel-lines">
            <span className="clozr-skel-line" />
            <span className="clozr-skel-line clozr-skel-line-sm" />
          </span>
        </span>
      ))}
    </div>
  );
}

/** The signed-in frame while the workspace read is still in flight. */
export function AppSkeleton() {
  return (
    <div className="clozr-skel" aria-busy="true" aria-label="Loading your workspace">
      <header className="clozr-skel-head">
        <span className="clozr-skel-mark" />
        <span className="clozr-skel-gap" />
        <span className="clozr-skel-icon" />
        <span className="clozr-skel-icon clozr-skel-icon-fill" />
        <span className="clozr-skel-icon" />
        <span className="clozr-skel-icon" />
      </header>
      <div className="clozr-skel-body">
        <span className="clozr-skel-line clozr-skel-line-lg" />
        <SkeletonRows count={7} label="Loading records" />
      </div>
      <nav className="clozr-skel-tabs" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => <span key={i} className="clozr-skel-tab" />)}
      </nav>
    </div>
  );
}
