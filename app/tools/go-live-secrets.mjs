// One-time go-live secrets for dispo campaigns. Run from app/:
//   CLOZR_PROJECT_REF=<ref> TALKR_PROJECT_REF=<ref> node tools/go-live-secrets.mjs
// Needs `npx supabase login` done. Prints names and lengths only, never a secret value.
//  1. CLOZR Vault: clozr_project_url + clozr_service_role_key (the campaign cron calls the tick with them)
//  2. Server texting: a fresh shared secret, set as CLOZR's TALKR_PARTNER_JWT_SECRET and on Talkr's
//     CLOZR partner_apps row (Talkr verifies partner tokens by that secret first, then JWKS).
//  3. Lists CLOZR function secrets so you can see whether ANTHROPIC_API_KEY is set.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLOZR = process.env.CLOZR_PROJECT_REF ?? '';
const TALKR = process.env.TALKR_PROJECT_REF ?? '';
if (!/^[a-z]{20}$/.test(CLOZR) || !/^[a-z]{20}$/.test(TALKR)) {
  console.error('Set CLOZR_PROJECT_REF and TALKR_PROJECT_REF to your two Supabase project refs.');
  process.exit(2);
}
const sb = (args, opts = {}) => execSync(`npx -y supabase@latest ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const dir = mkdtempSync(join(tmpdir(), 'clozr-secrets-'));
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

try {
  // 1. Vault
  const keys = JSON.parse(sb(`projects api-keys --project-ref ${CLOZR} --reveal -o json`));
  const srk = keys.find((k) => k.name === 'service_role')?.api_key ?? '';
  if (!/^eyJ[\w.-]+$/.test(srk)) throw new Error('Could not read the legacy service_role key.');
  const upsert = (name, val) =>
    `do $$ declare v uuid; begin select id into v from vault.secrets where name = ${lit(name)};
     if v is null then perform vault.create_secret(${lit(val)}, ${lit(name)}); else perform vault.update_secret(v, ${lit(val)}); end if; end $$;`;
  const vaultSql = join(dir, 'vault.sql');
  writeFileSync(vaultSql, `${upsert('clozr_project_url', `https://${CLOZR}.supabase.co`)}\n${upsert('clozr_service_role_key', srk)}\n`);
  sb(`db query --project-ref ${CLOZR} -f "${vaultSql}"`);
  console.log('1. Vault:', sb(`db query --project-ref ${CLOZR} "select name, length(decrypted_secret) as len from vault.decrypted_secrets where name like 'clozr_%'"`).trim());

  // 2. Shared texting secret
  const shared = randomBytes(48).toString('base64url');
  const envFile = join(dir, 'fn.env');
  writeFileSync(envFile, `TALKR_PARTNER_JWT_SECRET=${shared}\n`);
  sb(`secrets set --project-ref ${CLOZR} --env-file "${envFile}"`);
  const talkrSql = join(dir, 'talkr.sql');
  writeFileSync(talkrSql, `update public.partner_apps set secret = ${lit(shared)}, updated_at = now() where issuer = ${lit(`https://${CLOZR}.supabase.co/auth/v1`)};\n`);
  sb(`db query --project-ref ${TALKR} -f "${talkrSql}"`);
  console.log('2. Talkr partner row:', sb(`db query --project-ref ${TALKR} "select name, length(secret) as len from public.partner_apps where name = 'CLOZR'"`).trim());

  // 3. What CLOZR functions have
  const names = sb(`secrets list --project-ref ${CLOZR}`);
  for (const n of ['TALKR_PARTNER_JWT_SECRET', 'ANTHROPIC_API_KEY']) console.log(`3. ${n}: ${names.includes(n) ? 'set' : 'MISSING'}`);
  console.log('Done. Campaign sends start on the next minute tick.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
