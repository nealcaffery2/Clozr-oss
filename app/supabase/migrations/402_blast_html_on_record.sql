-- 402 · Dispo blast emails show on the record as the email the buyer got.
--
-- The dispo sender filed only the plain-text part of each email on
-- communications.body, so a buyer's Activity showed a plain copy of a blast
-- that went out as the branded HTML template. New sends now file the HTML
-- (dispo-campaign-tick, filedEmailBody in _shared/resend.ts). This copies the
-- stored HTML onto the rows already sent. Only rows still holding the plain
-- copy are touched, and only HTML under the 120,000-character cap the Gmail
-- sync uses. Safe to re-run.

update public.communications c
set body = m.body_html
from public.dispo_campaign_messages m
where m.communication_id = c.id
  and m.channel = 'email'
  and m.status = 'sent'
  and m.body_html is not null
  and length(m.body_html) <= 120000
  and c.body is distinct from m.body_html
  and c.body !~* '<(html|body|table|div)[\s>]';
