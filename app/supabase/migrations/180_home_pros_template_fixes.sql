-- 180 · Data fixes to one production workspace's uploaded PDF templates
-- (signer roles and signing windows found in a PandaDoc parity review).
--
-- Removed in the open-source release: it only edited that company's own
-- template rows. No schema change was in this file. Kept as a no-op so the
-- migration ledger order holds.
select 1;
