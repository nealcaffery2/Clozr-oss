'use client';

// The two callbacks the inbox's message tabs are handed by the screen above
// them. They live here rather than beside any one tab because the Email tab is
// being rebuilt and both the old and the new one need them.

import type React from 'react';
import type { MessageTemplate } from '@/lib/message-templates';
import type { ClozrRecord } from '@/app/components/talkr/MessagesScreen';

/** The merge-field values for one recipient: what `{{first_name}}` and friends resolve to. */
export type MergeFor = (rec: ClozrRecord | null, name: string, to: string) => Record<string, string>;

/** Renders the template picker as a tray or popover, wherever the caller puts it. */
export type PickerRender = (args: {
  channel: 'sms' | 'email';
  audience: MessageTemplate['audience'] | 'any';
  onPick: (t: MessageTemplate) => void;
  onClose: () => void;
}) => React.ReactNode;
