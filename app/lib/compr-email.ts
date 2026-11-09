// Plain email-building helpers. The hosted build styles one workspace's mail in
// its own look; the open-source build uses simple markup.

export const escHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const link = (href: string, label: string) => `<a href="${href}">${label}</a>`;
export function linkifyHtml(s: string): string {
  return escHtml(s).replace(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g, (u) => link(u, u));
}
export const isAppLine = (_p: string) => false;
export const APP_URL = '';
const CTA_LINE = /^\[([^\]\n]{1,60})\]\(((?:https?:\/\/|\{\{)[^)\s]+)\)$/;
const IMAGE_LINE = /^!\[([^\]\n]{0,120})\]\((https:\/\/[^)\s]+)\)$/;
export function imageOf(line: string): { alt: string; url: string } | null {
  const m = line.trim().match(IMAGE_LINE);
  return m ? { alt: m[1], url: m[2] } : null;
}
export function ctaOf(line: string): { label: string; url: string } | null {
  const m = line.trim().match(CTA_LINE);
  return m ? { label: m[1], url: m[2] } : null;
}
export const comprPara = (html: string, _small = false) => `<p>${html}</p>`;
export const comprHeading = (text: string) => `<h2>${escHtml(text)}</h2>`;
export const comprButton = (label: string, href: string) => `<p>${link(href, escHtml(label))}</p>`;
export const comprSteps = (items: string[]) => `<ol>${items.map((i) => `<li>${i}</li>`).join('')}</ol>`;
export const comprCallout = (html: string) => `<blockquote>${html}</blockquote>`;
export const comprSignature = (name: string, phone?: string) => `<p>${escHtml(name)}${phone ? `<br>${escHtml(phone)}` : ''}</p>`;
export const comprDivider = () => '<hr>';
export const comprImage = (url: string, alt: string) => `<img src="${url}" alt="${escHtml(alt)}" style="max-width:100%">`;
export const ctaPlain = (text: string) => text;
export function comprShell(p: { title: string; preheader?: string; rows: string; footer?: string; footerHtml?: string }): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escHtml(p.title)}</title></head><body>${p.rows}${p.footerHtml ?? (p.footer ? `<p>${escHtml(p.footer)}</p>` : '')}</body></html>`;
}
export const comprTextEmail = (text: string, opts: { title: string; preheader?: string; footer?: string }) =>
  comprShell({ title: opts.title, rows: text.split(/\n{2,}/).map((t) => comprPara(linkifyHtml(t))).join(''), footer: opts.footer });
