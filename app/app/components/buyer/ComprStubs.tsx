// Not part of the open-source build (hosted workspace only). Inert stand-ins
// that render nothing, so the shared Buyers screens still compile.
/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
export type PayPerson = { id: number; name: string; email: string | null; phone: string | null; tier: string | null };
export const TRIAL_ICON = '';
export const P_CAL = '';
export function PaymentLinkDialog(_p: any) { return null; }
export function PaymentLinkButton(_p: { onClick: () => void; compact?: boolean }) { return null; }
export function TrialLinkButton(_p: { onClick: () => void; compact?: boolean }) { return null; }
export function ExtendTrialDialog(_p: { onExtended?: (end: string) => void; [k: string]: any }) { return null; }
export function ExtendTrialButton(_p: { onClick: () => void; compact?: boolean }) { return null; }
export function ComprSuggested(_p: { onOpenBuyer?: (id: number) => void; onOpenPlan?: (id: number) => void; [k: string]: any }) { return null; }
export function ComprAutomations(_p: any) { return null; }
export function ComprAccountCard(_p: any) { return null; }
