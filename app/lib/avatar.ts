// Profile photos (migration 51): upload to the public avatars bucket under the
// user's own folder and point profiles.avatar_url at it.

import { notedWorkspaceId } from './active-workspace';
import { supabase } from './supabase';

export async function uploadAvatar(uid: string, file: File): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (!file.type.startsWith('image/')) return { ok: false, message: 'Pick an image file.' };
  if (file.size > 5 * 1024 * 1024) return { ok: false, message: 'That photo is over 5 MB.' };
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${uid}/${Date.now()}.${ext}`;
  const up = await supabase.storage.from('avatars').upload(path, file, { contentType: file.type, upsert: true });
  if (up.error) return { ok: false, message: up.error.message };
  const url = supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  // Older uploads of this user are removed so the folder holds one photo.
  const { data: old } = await supabase.storage.from('avatars').list(uid);
  const stale = (old ?? []).map((o) => `${uid}/${o.name}`).filter((p) => p !== path);
  if (stale.length) await supabase.storage.from('avatars').remove(stale);
  return { ok: true, url };
}

/** The photo to show for a signed-in user: their profile photo, else the one their sign-in provider gave. */
export function avatarOf(profileUrl: string | null | undefined, userMetadata: Record<string, unknown> | undefined): string | null {
  if (profileUrl) return profileUrl;
  const m = userMetadata ?? {};
  const v = (typeof m.avatar_url === 'string' && m.avatar_url) || (typeof m.picture === 'string' && m.picture) || null;
  return v || null;
}

// ---- teammates' photos by name or email, for screens that only know a name (Talkr's inbox) ----

let teamPhotos: Promise<Map<string, string>> | null = null;
let photoWs: number | null = null;

/** Drop the cached roster so the next read is the workspace on screen. */
export function forgetTeamPhotos(): void {
  teamPhotos = null;
  photoWs = null;
}

/** name / email (lowercased) → photo URL for the active workspace's roster. */
export function loadTeamPhotos(): Promise<Map<string, string>> {
  if (!supabase) return Promise.resolve(new Map());
  const ws = notedWorkspaceId();
  if (ws == null) return Promise.resolve(new Map());
  if (teamPhotos && photoWs === ws) return teamPhotos;
  photoWs = ws;
  teamPhotos = (async () => {
    const { data } = await supabase!.from('workspace_roster').select('full_name, email, avatar_url').eq('workspace_id', ws);
    const m = new Map<string, string>();
    for (const r of data ?? []) {
      if (!r.avatar_url) continue;
      if (r.full_name) m.set(r.full_name.trim().toLowerCase(), r.avatar_url);
      if (r.email) m.set(r.email.trim().toLowerCase(), r.avatar_url);
    }
    return m;
  })();
  return teamPhotos;
}
