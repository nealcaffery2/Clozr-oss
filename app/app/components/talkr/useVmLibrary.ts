'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { toWav } from '@/lib/audio-wav';

export type VmClip = {
  id: number;
  name: string;
  script: string;
  audio_path: string | null;
  variant_group: string;
  seconds: number | null;
  /** Who recorded it. Null on recordings saved before this was kept. */
  created_by: string | null;
};

/** Fired on window when a recording is saved, so every copy of the library re-reads. */
export const VM_LIBRARY_CHANGED = 'clozr-vm-library-changed';

const COLUMNS = 'id, name, script, audio_path, variant_group, seconds, created_by';

/** The workspace's voicemail recordings. RLS keeps this to workspaces the rep belongs to. */
export function useVmLibrary(workspaceId: number | null) {
  const [clips, setClips] = useState<VmClip[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!supabase || workspaceId == null) return;
    const { data, error: err } = await supabase.from('vm_library')
      .select(COLUMNS)
      .eq('workspace_id', workspaceId).eq('active', true).order('name');
    if (err) setError(err.message);
    else setClips((data ?? []) as VmClip[]);
  }, [workspaceId]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const on = () => { void reload(); };
    window.addEventListener(VM_LIBRARY_CHANGED, on);
    return () => window.removeEventListener(VM_LIBRARY_CHANGED, on);
  }, [reload]);

  const signedUrl = useCallback(async (path: string) => {
    if (!supabase) throw new Error('Not signed in.');
    const { data, error: err } = await supabase.storage.from('vm-library').createSignedUrl(path, 180);
    if (err || !data?.signedUrl) throw new Error(err?.message ?? 'That recording could not be opened.');
    return data.signedUrl;
  }, []);

  const saveClip = useCallback(async (name: string, script: string, blob: Blob, seconds: number): Promise<VmClip> => {
    if (!supabase || workspaceId == null) throw new Error('Sign in to save a recording.');
    // Saved as WAV: no ringless network and no Telnyx playback takes WebM.
    const wav = await toWav(blob);
    const path = `${workspaceId}/${crypto.randomUUID()}.wav`;
    const up = await supabase.storage.from('vm-library').upload(path, wav, { contentType: 'audio/wav' });
    if (up.error) throw new Error(up.error.message);
    // Kept so the dialer can tell a rep's own voicemail from a teammate's (lib/dialer-readiness.ts).
    const me = (await supabase.auth.getSession()).data.session?.user.id ?? null;
    const ins = await supabase.from('vm_library').insert({
      workspace_id: workspaceId, name: name.trim() || 'Voicemail', script, audio_path: path, seconds, variant_group: 'default', created_by: me,
    }).select(COLUMNS).single();
    if (ins.error) throw new Error(ins.error.message);
    const clip = ins.data as VmClip;
    setClips((rows) => [...rows, clip].sort((a, b) => a.name.localeCompare(b.name)));
    window.dispatchEvent(new CustomEvent(VM_LIBRARY_CHANGED));
    return clip;
  }, [workspaceId]);

  return { clips, error, reload, signedUrl, saveClip };
}
