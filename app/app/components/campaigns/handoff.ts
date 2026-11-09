// What People, the Inbox or a smart list hand the Campaigns screen when they
// push a selection into a campaign: the audience, and which campaign to add
// it to (null for a new one). Read once by the screen on mount.
import type { Audience, ContactKind } from '@/lib/sms-campaigns';

export type Handoff = { audience: Audience; campaignId: number | null; contact?: ContactKind };
let pending: Handoff | null = null;
export const setCampaignHandoff = (h: Handoff) => { pending = h; };
export function takeCampaignHandoff(): Handoff | null { const h = pending; pending = null; return h; }
