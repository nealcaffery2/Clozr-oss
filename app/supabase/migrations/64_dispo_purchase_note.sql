-- 64: every dispo text calls out the buyer's last purchase and how far it is
-- from this deal.
--
-- {{purchase_note}} is a new per-buyer merge field (supabase/functions/_shared/
-- dispo-rules.ts purchaseNote): one sentence built only from what is on file —
-- "It's 0.8 miles from the flip you did at 123 Main St 3 months ago." —
-- or nothing at all, in which case the renderer closes the gap (lib/sms.ts
-- renderMerge drops a line that held only blank fields). A template can carry
-- it anywhere and never send a hole. {{purchase_count}} is how many purchases
-- are on file.
--
-- 1. Dispo blast · Deal: the sentence under the headline, in the text
--    and the HTML (emails/clozr-dispo-blast.html is the source — the "!!!"
--    after the price is gone too). Guarded on the seeded copy's md5, so a
--    workspace that edited its own HTML keeps it.
-- 2. Dispo · New deal text: the sentence on the line under the headline. Only
--    where the seeded text is still in place.
-- 3. A third intro, "Dispo intro · Bought nearby", that reads right whatever is
--    on file. The two dated intros fall back to the generic intro unless every
--    one of their facts is present; the campaign builder now defaults to this
--    one, and the generic intro itself carries {{purchase_note}}.

-- ---- 1. the deal blast -------------------------------------------------
update public.message_templates
   set body_text = $text$Hi {{first_name}},

Off market deal in {{city}} — {{asking_price}}. {{purchase_note}}

{{full_address}}

{{description}}

Asking {{asking_price}} · ARV {{arv}} · {{beds}} bd / {{baths}} ba · {{sqft}} sqft · built {{year_built}}

Full deal: {{marketing_link}}
Photos: {{photos_link}}
Comps and underwriting: {{comps_link}}

Call me for more information.

{{rep_name}}
{{rep_phone}} · {{rep_email}}
{{company}}

{{company}} is marketing its equitable interest in a contract to purchase this property and does not hold legal title. ARV, repair estimates, photos and property details are for convenience only and are not guaranteed — complete your own due diligence. No unaccompanied entry: showings are scheduled with {{company}}. {{company}} does not represent you in this transaction; property is sold as is. Real estate investing is speculative and carries risk, including loss of capital.

This email was sent to {{name}} because you joined the {{company}} buyers list.$text$,
       body_html = $html$<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>Available - {{city}}</title>
<!--[if !mso]><!-->
<link href="https://fonts.googleapis.com/css?family=Source+Sans+Pro:400,600,700" rel="stylesheet">
<!--<![endif]-->
<style>
  body,table,td,p,a,h1,h2{font-family:'Source Sans Pro','Helvetica Neue',Helvetica,Arial,sans-serif;}
  @media only screen and (max-width:600px){
    .wrap{width:100% !important;}
    .px{padding-left:20px !important;padding-right:20px !important;}
    .spec{display:inline-block !important;width:50% !important;padding-bottom:16px !important;}
    .h1{font-size:24px !important;line-height:30px !important;}
    .promo-img,.promo-txt{display:block !important;width:100% !important;text-align:center !important;}
    .btn{width:100% !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F1F1F1;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#F1F1F1;">Off market in {{city}} at {{asking_price}}. ARV {{arv}}.</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F1F1;">
<tr><td align="center" style="padding:0;">

<!-- ============ HEADER ============ -->
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;border-bottom:6px solid #07345C;">
  <tr>
    <td align="center" style="padding:25px 30px;">
      <a href="https://example.com" target="_blank" style="text-decoration:none;">
        <img src="https://example.com/logo.png" width="240" alt="{{company}}" title="{{company}}" style="display:block;width:240px;max-width:100%;height:auto;border:0;">
      </a>
    </td>
  </tr>
</table>

<!-- ============ BODY ============ -->
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;">

  <!-- Headline -->
  <tr>
    <td class="px" align="center" style="padding:28px 30px 30px 30px;">
      <h1 class="h1" style="margin:0;font-size:26px;line-height:34px;font-weight:600;color:#2C2C2C;">Off Market Deal in {{city}}</h1>
      <p style="margin:6px 0 0 0;font-size:17px;line-height:26px;color:#2C2C2C;">{{asking_price}}</p>
      <p style="margin:14px 0 0 0;font-size:15px;line-height:24px;color:#07345C;">{{purchase_note}}</p>
    </td>
  </tr>

  <!-- Money shot -->
  <tr>
    <td align="center" style="padding:0;font-size:0;line-height:0;">
      <a href="{{marketing_link}}" target="_blank" style="text-decoration:none;">
        <img src="{{photo_url}}" width="600" alt="{{address}}" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
      </a>
    </td>
  </tr>

  <!-- Address -->
  <tr>
    <td class="px" align="center" style="padding:30px 30px 0 30px;">
      <h1 class="h1" style="margin:0;font-size:24px;line-height:30px;font-weight:700;"><a href="{{marketing_link}}" target="_blank" style="color:#000000;text-decoration:none;">{{full_address}}</a></h1>
    </td>
  </tr>

  <!-- Description -->
  <tr>
    <td class="px" style="padding:30px 30px 0 30px;">
      <h2 style="margin:0 0 10px 0;font-size:18px;line-height:28px;font-weight:600;color:#2C2C2C;">Property Description</h2>
      <p style="margin:0;font-size:16px;line-height:27px;color:#2C2C2C;">Hi {{first_name}}, {{description}}</p>
    </td>
  </tr>

  <!-- Specs -->
  <tr>
    <td class="px" style="padding:40px 30px 10px 30px;">
      <h2 style="margin:0;font-size:18px;line-height:28px;font-weight:600;color:#2C2C2C;">Property Specifications</h2>
    </td>
  </tr>
  <tr>
    <td class="px" style="padding:10px 30px 30px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;">
        <tr>
          <td class="spec" width="20%" valign="top" style="padding:0 4px;">
            <div style="width:28px;height:4px;background:#07345C;margin-bottom:10px;font-size:0;line-height:0;">&nbsp;</div>
            <p style="margin:0;font-size:14px;line-height:20px;font-weight:600;color:#2C2C2C;">Asking Price</p>
            <p style="margin:2px 0 0 0;font-size:14px;line-height:20px;color:#5C5C5C;">{{asking_price}}</p>
          </td>
          <td class="spec" width="20%" valign="top" style="padding:0 4px;">
            <div style="width:28px;height:4px;background:#07345C;margin-bottom:10px;font-size:0;line-height:0;">&nbsp;</div>
            <p style="margin:0;font-size:14px;line-height:20px;font-weight:600;color:#2C2C2C;">ARV</p>
            <p style="margin:2px 0 0 0;font-size:14px;line-height:20px;color:#5C5C5C;">{{arv}}</p>
          </td>
          <td class="spec" width="20%" valign="top" style="padding:0 4px;">
            <div style="width:28px;height:4px;background:#07345C;margin-bottom:10px;font-size:0;line-height:0;">&nbsp;</div>
            <p style="margin:0;font-size:14px;line-height:20px;font-weight:600;color:#2C2C2C;">Beds / Baths</p>
            <p style="margin:2px 0 0 0;font-size:14px;line-height:20px;color:#5C5C5C;">{{beds}} / {{baths}}</p>
          </td>
          <td class="spec" width="20%" valign="top" style="padding:0 4px;">
            <div style="width:28px;height:4px;background:#07345C;margin-bottom:10px;font-size:0;line-height:0;">&nbsp;</div>
            <p style="margin:0;font-size:14px;line-height:20px;font-weight:600;color:#2C2C2C;">Sq Ft</p>
            <p style="margin:2px 0 0 0;font-size:14px;line-height:20px;color:#5C5C5C;">{{sqft}}</p>
          </td>
          <td class="spec" width="20%" valign="top" style="padding:0 4px;">
            <div style="width:28px;height:4px;background:#07345C;margin-bottom:10px;font-size:0;line-height:0;">&nbsp;</div>
            <p style="margin:0;font-size:14px;line-height:20px;font-weight:600;color:#2C2C2C;">Year Built</p>
            <p style="margin:2px 0 0 0;font-size:14px;line-height:20px;color:#5C5C5C;">{{year_built}}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Button -->
  <tr>
    <td class="px" align="center" style="padding:20px 30px 10px 30px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" style="background:#07345C;">
            <a class="btn" href="{{marketing_link}}" target="_blank" style="display:inline-block;width:280px;max-width:100%;box-sizing:border-box;padding:12px 20px;font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:22px;font-weight:bold;color:#FFFFFF;text-decoration:none;text-align:center;">View Full Deal</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td class="px" align="center" style="padding:0 30px 30px 30px;">
      <p style="margin:0;font-size:14px;line-height:22px;color:#5C5C5C;"><a href="{{photos_link}}" target="_blank" style="color:#07345C;">Photos</a> &nbsp;|&nbsp; <a href="{{comps_link}}" target="_blank" style="color:#07345C;">Comps &amp; underwriting</a></p>
    </td>
  </tr>

  <!-- Signature -->
  <tr>
    <td class="px" style="padding:0 30px 30px 30px;">
      <h2 style="margin:0 0 20px 0;font-size:16px;line-height:27px;font-weight:400;color:#2C2C2C;">Call me for more information.</h2>
      <p style="margin:0;font-size:16px;line-height:27px;color:#2C2C2C;">
        <strong style="font-size:18px;font-weight:600;">{{rep_name}}</strong><br>
        <a href="tel:{{rep_phone}}" style="color:#2C2C2C;text-decoration:none;">{{rep_phone}}</a> | <a href="mailto:{{rep_email}}" style="color:#2C2C2C;">{{rep_email}}</a><br><br>
        {{company}}
      </p>
    </td>
  </tr>

  <!-- Promo box -->
  <tr>
    <td class="px" style="padding:0 30px 30px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#E8EEF4;border-radius:10px;">
        <tr>
          <td class="promo-txt" valign="middle" style="padding:24px;">
            <h2 style="margin:0;font-size:20px;line-height:25px;font-weight:600;color:#07345C;">Get {{company}} Deals Before Anyone Else</h2>
            <p style="margin:10px 0 18px 0;font-size:16px;line-height:22px;color:#2C2C2C;">Reply with your buy box: areas, price range, and strategy. We will send matching deals first.</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background:#FFFFFF;border:2px solid #07345C;">
                  <a href="mailto:{{rep_email}}?subject=My%20Buy%20Box" style="display:inline-block;padding:8px 18px;font-size:15px;font-weight:600;color:#07345C;text-decoration:none;">Send My Buy Box</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<!-- ============ FOOTER ============ -->
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#07345C;">
  <tr>
    <td class="px" style="padding:30px 30px 0 30px;">
      <p style="margin:0;font-size:24px;line-height:28px;font-weight:700;color:#FFFFFF;letter-spacing:1px;">{{company}}</p>
      <p style="margin:2px 0 0 0;font-size:12px;line-height:16px;color:#B9CCE0;letter-spacing:1px;">YOUR TRUSTED AS-IS HOMEBUYERS</p>
    </td>
  </tr>
  <tr>
    <td class="px" style="padding:30px 30px 30px 30px;">
      <p style="margin:0;font-size:12px;line-height:18px;color:#FFFFFF;">
        <strong>Notice and Disclosures</strong><br><br>
        1. EQUITABLE INTEREST: {{company}} is marketing its equitable interest in a contract to purchase this property. {{company}} does not hold legal title to the property.<br><br>
        2. VERIFY ALL INFORMATION: ARV, repair estimates, photos, and property details are provided for convenience only and are not guaranteed. Buyer must complete their own due diligence.<br><br>
        3. NO UNACCOMPANIED ENTRY: Access to the property is only permitted through a showing scheduled with {{company}}.<br><br>
        4. NON-REPRESENTATION: {{company}} does not represent you in this transaction. Property is sold as is.<br><br>
        5. RISK OF LOSS: Real estate investing is speculative and carries risk, including loss of capital.
      </p>
      <p style="margin:30px 0 0 0;font-size:12px;line-height:18px;color:#FFFFFF;">
        This email was sent to {{name}} because you joined the {{company}} buyers list.<br><br>
        &copy; {{company}}
      </p>
    </td>
  </tr>
</table>

</td></tr>
</table>
</body>
</html>
$html$,
       merge_fields = array['first_name', 'city', 'asking_price', 'purchase_note', 'full_address', 'description', 'arv', 'beds', 'baths', 'sqft', 'year_built', 'marketing_link', 'photos_link', 'comps_link', 'rep_name', 'rep_phone', 'rep_email', 'company', 'name', 'photo_url', 'address'],
       updated_at = now()
 where name = 'Dispo blast · Deal' and channel = 'email' and archived_at is null
   and md5(body_html) = '9f380b5b57b6d78e98f078151d6e1dd5';

-- ---- 2. the SMS deal brief -------------------------------------------------
update public.message_templates
   set body_text = $text${{headline}}
{{purchase_note}}

Address: {{full_address}}
Asking Price: {{cash_price}}
Estimated ARV: {{arv}}
Beds / Baths: {{beds}}/{{baths}}
Living Area: {{sqft}} sq ft
Year Built: {{year_built}}

More Info: {{marketing_link}}
Comps: {{comps_link}}

{{rep_name}} · {{company}} · {{rep_phone}}
Reply STOP to opt out.$text$,
       merge_fields = array['headline', 'purchase_note', 'full_address', 'cash_price', 'arv', 'beds', 'baths', 'sqft', 'year_built', 'marketing_link', 'comps_link', 'rep_name', 'company', 'rep_phone'],
       updated_at = now()
 where name = 'Dispo · New deal text' and channel = 'sms' and archived_at is null
   and body_text not like '%purchase_note%'
   and body_text like E'{{headline}}\n\nAddress: {{full_address}}%';

-- ---- 3. the intro that works from whatever is on file ---------------------
insert into public.message_templates (workspace_id, owner_id, shared, name, channel, audience, category, body_text, merge_fields)
select w.id, w.owner_id, true, 'Dispo intro · Bought nearby', 'sms', 'buyer', 'dispo-intro',
       $text$Hey {{first_name}} - it's {{rep_first_name}}. I've got a {{property_type}} deal in {{city}} that fits what you buy. {{purchase_note}}{{similar_size}} Want more details?$text$,
       array['first_name', 'rep_first_name', 'property_type', 'city', 'purchase_note', 'similar_size']
  from public.workspaces w
 where not exists (select 1 from public.message_templates x where x.workspace_id = w.id and x.name = 'Dispo intro · Bought nearby' and x.archived_at is null);
