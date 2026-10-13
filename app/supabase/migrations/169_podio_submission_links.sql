-- 169 · A Podio Submissions item stores its id and provider report link on the deal.
--
-- The live sync links a Jotform (or any other) deal on the same property
-- instead of creating a second one, and writes the Podio item id onto that
-- deal when it is still blank. The provider report URL from the submission's underwriting
-- field is kept beside underwriting_url. No sync_cursor clear: the field-map
-- version on podio_items.applied (__v) is what makes the next pass re-apply.

alter table public.deals add column if not exists podio_item_id bigint;
alter table public.deals add column if not exists compr_report_url text;

create index if not exists deals_podio_item_id_idx
  on public.deals (workspace_id, podio_item_id)
  where podio_item_id is not null;

comment on column public.deals.podio_item_id is 'Podio Submissions item id, set by podio-import when the deal is linked or created. Null until then.';
comment on column public.deals.compr_report_url is 'Underwriting provider report link from the Submissions underwriting field. underwriting_url stays the analysis link.';
