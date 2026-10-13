// The blacklist the team does not see on People or Buyers. It is a tag so it
// rides the rows we already store. Account is the only screen that lists it.

export const SECRET_BLACKLIST_TAG = 'secret-blacklist';

export function isSecretTag(tag: string): boolean {
  return tag.trim().toLowerCase() === SECRET_BLACKLIST_TAG;
}

export function isSecretBlacklisted(tags: readonly string[] | null | undefined): boolean {
  return (tags ?? []).some(isSecretTag);
}

export function visibleTags(tags: string[]): string[] {
  return tags.filter((t) => !isSecretTag(t));
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Account's export. Name, whether they were a person or a buyer, and how to reach them. */
export function secretListCsv(rows: { name: string; kind: string; phone: string; email: string; detail: string; reason?: string }[]): string {
  const head = 'name,kind,phone,email,detail,reason';
  const body = rows.map((r) => [r.name, r.kind, r.phone, r.email, r.detail, r.reason ?? ''].map(csvCell).join(','));
  return [head, ...body].join('\n');
}
