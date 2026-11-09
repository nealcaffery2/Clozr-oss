-- 433 · wholesaler_entities.source accepts 'investorlift'.
--
-- Deal Machine's cloud run now writes the wholesaler behind every InvestorLift
-- listing it reads (deal-machine-cloud, sellerEntity), so the LLC list Genius
-- searches deeds by grows with every sweep. The check constraint named the
-- sources that existed before; this rebuilds it with one more. Safe to re-run.

alter table public.wholesaler_entities drop constraint if exists wholesaler_entities_source_check;
alter table public.wholesaler_entities add constraint wholesaler_entities_source_check
  check (source = any (array['drive', 'deed', 'manual', 'genius', 'contract', 'vendor', 'buyer', 'investorlift']));
