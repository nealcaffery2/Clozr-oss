// Not part of the open-source build: the hosted CLOZR workspace for the
// underwriting product uses this. Inert stand-in with the same exports.

export type PlaybookTemplate = { name: string; channel: string; subject?: string; body: string };
export type { PlaybookScript } from './example-playbook';
import type { PlaybookScript } from './example-playbook';
export const COMPR_FOOTER = '';
export const COMPR_TEMPLATES: readonly PlaybookTemplate[] = [];
export const COMPR_SCRIPTS: readonly PlaybookScript[] = [];
