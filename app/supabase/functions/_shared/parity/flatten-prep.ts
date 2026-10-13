// Before the executed PDF is drawn: map the new field types onto the ones
// planFlatten() already knows how to draw, blank fields hidden by a failed
// condition, and make sure formula values are current.
//
//   radio      → checkbox (ticked when chosen)
//   email/phone/formula → text
//   attachment → text "See attachment: <label>"
//   stamp      → signature (an image)

import { computeFormulas, hiddenAtCompletion, type LogicField } from './field-logic.ts';

type F = { id?: number; type: string; page: number; x: number; y: number; w: number; h: number; value?: string | null; label?: string | null } & Partial<LogicField>;

export function prepareForFlatten<T extends F>(fields: T[], attachmentLabels: Map<number, string> = new Map()): T[] {
  const logic = fields.map((f, i) => ({ ...f, id: f.id ?? i })) as unknown as LogicField[];
  const formulas = computeFormulas(logic);
  const hidden = hiddenAtCompletion(logic);
  return fields.map((f, i) => {
    const id = (f.id ?? i) as number;
    if (hidden.has(id)) return { ...f, value: null };
    switch (f.type) {
      case 'radio': return { ...f, type: 'checkbox', value: f.value === 'true' ? 'true' : '' };
      case 'email': case 'phone': return { ...f, type: 'text' };
      case 'formula': return { ...f, type: 'text', value: formulas.get(id) ?? f.value ?? '' };
      case 'attachment': return { ...f, type: 'text', value: f.value ? `See attachment: ${attachmentLabels.get(Number(f.value)) ?? '#' + f.value}` : '' };
      case 'stamp': return { ...f, type: 'signature' };
      default: return f;
    }
  });
}
