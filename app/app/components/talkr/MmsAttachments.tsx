'use client';

/**
 * MMS attachments on a text composer: shrink a photo, upload it to Talkr, show
 * it above the box with a way to take it off again. The inbox thread
 * (MessagesScreen) and the dialer's text card (DialerTexts) share this, so the
 * limits (lib/mms) and the preview look the same in both.
 *
 * Without Talkr (the demo) nothing is uploaded: the file stays a local object
 * URL, which is enough to preview it and to "send" it into the sample thread.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/talkr-web/api';
import { type AttachmentKind, MMS_IMAGE_MAX_EDGE, MMS_MAX_FILES, kindFromType, kindFromUrl, mmsRefusal } from '@/lib/mms';
import { Icon } from './Icon';

/** A file the rep picked, uploaded (or held locally in the demo) and waiting on the composer. */
export interface PendingAttachment {
  url: string;
  previewUrl: string | null;
  name: string;
  kind: AttachmentKind;
}

export async function shrinkImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MMS_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 800 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return blob ?? file;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read file'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * The attachments on one composer. `local` keeps files in the browser instead
 * of uploading them (the demo). `take` hands the list to a send and empties the
 * composer without revoking the previews, so a bubble that shows them keeps
 * working; `clear` revokes them.
 */
export function useMmsAttachments({ local = false }: { local?: boolean } = {}) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<PendingAttachment[]>([]);
  live.current = attachments;

  // Previews still on the composer when it goes away.
  useEffect(() => () => {
    for (const a of live.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    setError(null);
    setUploading(true);
    let count = live.current.length;
    try {
      for (const file of Array.from(files)) {
        let blob: Blob = file;
        const kind = kindFromType(file.type);
        if (kind === 'image') {
          try {
            blob = await shrinkImage(file);
          } catch {
            throw new Error(`Couldn't read ${file.name}. Use a JPEG or PNG (HEIC is not supported here).`);
          }
        }
        const refusal = mmsRefusal({ name: file.name, type: file.type || blob.type, size: blob.size }, count);
        if (refusal) throw new Error(refusal);
        const previewUrl = kind === 'image' ? URL.createObjectURL(blob) : null;
        const url = local
          ? previewUrl ?? URL.createObjectURL(blob)
          : (await api.uploadMedia({ content_type: blob.type || file.type, data_base64: await blobToBase64(blob), filename: file.name })).url;
        count += 1;
        setAttachments((cur) => [...cur, { url, previewUrl, name: file.name, kind }]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }, [local]);

  const remove = useCallback((url: string) => {
    setAttachments((cur) => {
      const gone = cur.find((a) => a.url === url);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      if (gone && local && gone.url !== gone.previewUrl) URL.revokeObjectURL(gone.url);
      return cur.filter((a) => a.url !== url);
    });
  }, [local]);

  const clear = useCallback(() => {
    setAttachments((cur) => {
      for (const a of cur) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        if (local && a.url !== a.previewUrl) URL.revokeObjectURL(a.url);
      }
      return [];
    });
  }, [local]);

  const take = useCallback((): PendingAttachment[] => {
    const out = live.current;
    setAttachments([]);
    return out;
  }, []);

  return { attachments, uploading, error, setError, addFiles, remove, clear, take, full: attachments.length >= MMS_MAX_FILES };
}

/** The row of picked files above a composer: a thumbnail per photo, a named chip per file, each with a remove button. */
export function PendingAttachments({ attachments, uploading, onRemove, className }: {
  attachments: PendingAttachment[];
  uploading: boolean;
  onRemove: (url: string) => void;
  className?: string;
}) {
  if (attachments.length === 0 && !uploading) return null;
  return (
    <div className={className ?? 'flex flex-wrap items-center gap-2.5'}>
      {attachments.map((a) => (
        <span
          key={a.url}
          className="relative inline-flex items-center gap-2"
          style={{
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--panel)',
            padding: a.previewUrl ? 3 : '7px 10px',
            font: '500 11px/1 var(--sans)',
          }}
        >
          {a.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL
            <img
              src={a.previewUrl}
              alt={a.name}
              style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 8, display: 'block' }}
            />
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Icon name={a.kind === 'video' ? 'play' : 'image'} size={13} />
              {a.name}
            </span>
          )}
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            title={`Remove ${a.name}`}
            onClick={() => onRemove(a.url)}
            className="mms-remove inline-flex items-center justify-center rounded-full"
            style={{ position: 'absolute', top: -8, right: -8, width: 24, height: 24, background: '#1c1c1e', color: '#fff', cursor: 'pointer', border: '2px solid var(--panel)' }}
          >
            <Icon name="x" size={11} strokeWidth={2.5} />
          </button>
        </span>
      ))}
      {uploading && <span role="status" style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted-2)' }}>Uploading…</span>}
    </div>
  );
}

/**
 * An MMS attachment in a thread. The photo shows as the photo; a carrier media
 * URL can be short-lived or need credentials we deliberately do not put in the
 * browser, so a failed load falls back to a labelled placeholder rather than a
 * broken image icon.
 */
export function MmsImage({ url, mine, kind: known, name: knownName }: {
  url: string; mine: boolean;
  /** Known for a file picked here (a local object URL says nothing about its type). */
  kind?: AttachmentKind; name?: string;
}) {
  const [failed, setFailed] = useState(false);
  const kind = known ?? kindFromUrl(url);
  const box = {
    width: 230,
    maxWidth: '100%',
    borderRadius: 14,
    background: mine ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.06)',
  } as const;

  if (kind === 'video') {
    return (
      <video controls preload="metadata" src={url} style={{ ...box, display: 'block', maxHeight: 260 }} />
    );
  }
  if (kind === 'file') {
    const name = knownName ?? decodeURIComponent(url.split('?')[0]!.split('/').pop() ?? 'file');
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2"
        style={{ ...box, width: 'auto', padding: '8px 12px', font: '600 11px/1 var(--sans)', color: 'inherit', textDecoration: 'none' }}
      >
        <Icon name="image" size={14} />
        {name}
      </a>
    );
  }

  if (failed) {
    return (
      <span
        className="flex items-center justify-center gap-2"
        style={{
          ...box,
          height: 138,
          font: '600 10px/1 var(--sans)',
        }}
      >
        <Icon name="image" size={18} />
        Image
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- carrier-hosted, not ours to optimize
    <img
      src={url}
      alt="Attachment"
      onError={() => setFailed(true)}
      style={{ ...box, display: 'block', maxHeight: 260, objectFit: 'cover' }}
    />
  );
}
