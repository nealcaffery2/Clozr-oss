// hCaptcha, loaded only when a site key exists.
//
// Bot protection for the four auth forms. The site key is public and inlined
// at build time (NEXT_PUBLIC_HCAPTCHA_SITE_KEY); the secret lives in the
// Supabase dashboard under Authentication → Attack protection, where GoTrue
// verifies the token server-side. No key: no script, no widget, and the forms
// behave exactly as before.

type Hcaptcha = {
  render: (el: HTMLElement, opts: { sitekey: string; size?: 'normal' | 'compact' | 'invisible' }) => string;
  getResponse: (widgetId?: string) => string;
  reset: (widgetId?: string) => void;
};

declare global {
  interface Window { hcaptcha?: Hcaptcha; __clozrHcaptcha?: Promise<Hcaptcha> }
}

export const HCAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY || '';

export function captchaEnabled(): boolean {
  return HCAPTCHA_SITE_KEY.length > 0;
}

export function loadHcaptcha(): Promise<Hcaptcha> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.hcaptcha) return Promise.resolve(window.hcaptcha);
  if (window.__clozrHcaptcha) return window.__clozrHcaptcha;
  window.__clozrHcaptcha = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://js.hcaptcha.com/1/api.js?render=explicit';
    el.async = true;
    el.defer = true;
    el.onload = () => {
      if (window.hcaptcha) resolve(window.hcaptcha);
      else reject(new Error('hCaptcha did not load'));
    };
    el.onerror = () => reject(new Error('Could not load hCaptcha'));
    document.head.appendChild(el);
  });
  return window.__clozrHcaptcha;
}
