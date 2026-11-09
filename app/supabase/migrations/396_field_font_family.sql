-- A field's font on the signed PDF: auto (match the document's own font),
-- helvetica, times or courier. font_size (migration 179) is the size in points;
-- null means fit the box.
alter table public.contract_fields add column if not exists font_family text;
alter table public.doc_template_fields add column if not exists font_family text;
