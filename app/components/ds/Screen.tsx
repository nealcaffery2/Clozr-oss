// The frame every screen in app/clozr/screens shares: one header bar with one
// h1, and one gutter and width rule for the body (app/DESIGN.md §3, §4).
//
//   <ScreenFrame width="form" header={<ScreenHeader title="Account" />}>
//     …the form…
//   </ScreenFrame>
//
// Screens with their own body layout (rails, boards, tables that scroll on
// their own) use ScreenHeader alone as the first child of their column.
//
// ScreenHeader is a 56px bar: back link, the title (16/700, the screen's only
// h1), an optional meta line, and actions on the right. When the actions do
// not fit beside the title they wrap onto their own row, and wrap again
// inside it, so no action is ever drawn past the edge of the window.
'use client';

import React from 'react';
import { BackLink, type BackTarget } from '@/components/ds/BackLink';

export type ScreenHeaderProps = {
  /** The screen's name. Rendered as the screen's one <h1>. */
  title: React.ReactNode;
  /** A short muted line beside the title: a count, a date, "15 deals". */
  meta?: React.ReactNode;
  /** Controls on the right: buttons, a search, a view switch. They wrap, never clip. */
  actions?: React.ReactNode;
  /** Where Back goes (from useClozr's backFor). Shown before the title. */
  back?: BackTarget;
  /** Controls that sit before the title (a rail toggle, a list switch). */
  before?: React.ReactNode;
  /** Something that belongs with the title rather than the actions (a list picker, a status badge). */
  after?: React.ReactNode;
  /** A second row inside the bar: tabs or filter chips. Full width, under the title. */
  children?: React.ReactNode;
  /** Set when the title is a control of its own (an editable name), so the h1 holds it as is. */
  titleTitle?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Passed to the bar, e.g. data-screen-label. */
  'data-screen-label'?: string;
};

export function ScreenHeader({ title, meta, actions, back, before, after, children, titleTitle, className, style, ...rest }: ScreenHeaderProps) {
  return (
    <header className={'ds-screen-header' + (className ? ' ' + className : '')} style={style} {...rest}>
      <div className="ds-screen-header__lead">
        {back ? <BackLink to={back} /> : null}
        {before}
        <div className="ds-screen-header__heading">
          <h1 className="ds-title ds-screen-header__title" title={titleTitle ?? (typeof title === 'string' ? title : undefined)}>{title}</h1>
          {meta != null && meta !== false ? <span className="ds-screen-header__meta">{meta}</span> : null}
        </div>
        {after}
      </div>
      {actions ? <div className="ds-screen-header__actions">{actions}</div> : null}
      {children ? <div className="ds-screen-header__row">{children}</div> : null}
    </header>
  );
}

export type ScreenWidth = 'fluid' | 'form';

/**
 * A screen's column: the header, then a body that scrolls. `fluid` (lists,
 * boards, records) takes the whole width; `form` (settings, account, forms)
 * stops at 960px. The body carries the one gutter: 20px on a desk, 16px on a
 * phone. Pass `padded={false}` when the body draws its own edge to edge rows.
 */
export function ScreenFrame({ header, width = 'fluid', padded = true, scroll = true, children, className, style, bodyStyle, ...rest }: {
  header?: React.ReactNode;
  width?: ScreenWidth;
  padded?: boolean;
  scroll?: boolean;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
  'data-screen-label'?: string;
}) {
  return (
    <div className={'ds-screen' + (className ? ' ' + className : '')} style={style} {...rest}>
      {header}
      <div className="ds-screen-body" data-scroll={scroll ? 'y' : undefined} data-padded={padded ? '' : undefined} style={bodyStyle}>
        <div className="ds-screen-inner" data-width={width}>{children}</div>
      </div>
    </div>
  );
}

/** Running text: stops at 72 characters a line (DESIGN.md §4). */
export function Prose({ as: Tag = 'p', children, className, style }: { as?: 'p' | 'div'; children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return <Tag className={'ds-prose' + (className ? ' ' + className : '')} style={style}>{children}</Tag>;
}
