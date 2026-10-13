// The two menus the shell opens from more than one place: Quick add and the
// account menu. The phone header and the desk side menu both mount them, so
// they live here once; the caller only says where the panel sits.
'use client';

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { displayName, useSession } from '@/lib/session';
import { ROLE_LABEL, type Role } from '@/lib/team';

/** Quick add: every record type the role can create, with its Q shortcut. */
export function QuickAddMenu({ V, style }: { V: ClozrView; style: React.CSSProperties }) {
  return (
    <div className="cz-menu" style={{ zIndex: 60, ...style }}>
      <div style={{fontSize: "10.5px", fontWeight: "600", letterSpacing: "0.1em", textTransform: "uppercase", color: "#a1a1aa", padding: "8px 10px 6px"}}>
        Quick add
      </div>
      {(V.quickAddItems || []).map((q, q__i) => (
        <React.Fragment key={q__i}>
        <button className="dc2" onClick={q.go} style={{display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", height: "34px", padding: "0 10px", border: "0", borderRadius: "8px", background: "none", cursor: "pointer", fontSize: "13px", color: "#18181b", textAlign: "left"}}>
          <span>
            {q.label}
          </span>
          <span style={{fontSize: "11px", color: "#a1a1aa"}}>
            {q.key}
          </span>
        </button>
        </React.Fragment>
      ))}
    </div>
  );
}

/** The account menu: who is signed in, workspaces, Account, Settings, sign in or out. */
export function AccountMenu({ V, className, style }: { V: ClozrView; className: string; style: React.CSSProperties }) {
  const session = useSession();
  const who = displayName(session);
  return (
    <>
    <div onClick={V.closeAccountMenu} style={{position: "fixed", inset: "0", zIndex: "59"}}></div>
    <div role="menu" className={className} style={{ zIndex: 60, ...style }}>
      <div style={{padding: "9px 10px 10px", borderBottom: "1px solid #f0f0f1", marginBottom: "4px"}}>
        <div style={{fontSize: "13.5px", fontWeight: "600", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
          {who}
        </div>
        <div style={{fontSize: "11.5px", color: "#a1a1aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
          {session.user?.email ?? 'Sample data · not signed in'}
        </div>
        {(session.workspace) ? (
          <div style={{fontSize: "11.5px", color: "#71717a", marginTop: "3px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
            {session.workspace.name}
          </div>
        ) : null}
      </div>
      {session.workspaces.length > 1 ? (
        <div style={{padding: "2px 0 4px"}}>
          <div style={{fontSize: "10.5px", fontWeight: "600", letterSpacing: "0.1em", textTransform: "uppercase", color: "#a1a1aa", padding: "6px 10px 4px"}}>
            Workspaces
          </div>
          {session.workspaces.map((w) => {
            const on = w.id === session.workspace?.id;
            const role = ROLE_LABEL[w.role as Role] ?? w.role;
            return (
              <button
                key={w.id}
                role="menuitemradio"
                aria-checked={on}
                className="dc2"
                onClick={() => { if (!on) session.switchWorkspace(w.id); V.closeAccountMenu(); }}
                style={{display: "flex", alignItems: "center", gap: "8px", width: "100%", textAlign: "left", minHeight: "34px", padding: "5px 10px", border: "0", borderRadius: "8px", background: on ? "#E7F8F1" : "none", cursor: "pointer"}}
              >
                <span style={{flex: "1", minWidth: "0"}}>
                  <span style={{display: "block", fontSize: "13px", fontWeight: on ? "600" : "500", color: "#18181b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                    {w.name}
                  </span>
                  <span style={{display: "block", fontSize: "11px", color: "#a1a1aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                    {role}
                  </span>
                </span>
                {on ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{color: "var(--c-accent)", flex: "none"}}><path d="M20 6 9 17l-5-5" /></svg> : null}
              </button>
            );
          })}
          <div style={{height: "1px", background: "#f0f0f1", margin: "4px 0"}}></div>
        </div>
      ) : null}
      <button role="menuitem" className="dc2" onClick={V.goAccount} style={{display: "block", width: "100%", textAlign: "left", height: "34px", padding: "0 10px", border: "0", borderRadius: "8px", background: "none", cursor: "pointer", fontSize: "13px", color: "#18181b"}}>
        Account
      </button>
      <button role="menuitem" className="dc2" onClick={V.goSettings} style={{display: "block", width: "100%", textAlign: "left", height: "34px", padding: "0 10px", border: "0", borderRadius: "8px", background: "none", cursor: "pointer", fontSize: "13px", color: "#18181b"}}>
        Settings
      </button>
      <div style={{height: "1px", background: "#f0f0f1", margin: "4px 0"}}></div>
      {(session.demo) ? (
        <a role="menuitem" href="/login" className="dc2" style={{display: "block", width: "100%", textAlign: "left", lineHeight: "34px", height: "34px", padding: "0 10px", borderRadius: "8px", fontSize: "13px", color: "#18181b", textDecoration: "none"}}>
          Sign in
        </a>
      ) : (
        <button role="menuitem" className="dc2" onClick={() => void session.signOut()} style={{display: "block", width: "100%", textAlign: "left", height: "34px", padding: "0 10px", border: "0", borderRadius: "8px", background: "none", cursor: "pointer", fontSize: "13px", color: "#18181b"}}>
          Sign out
        </button>
      )}
    </div>
    </>
  );
}
