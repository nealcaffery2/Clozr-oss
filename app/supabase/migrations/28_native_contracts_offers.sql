-- 27 — Contracts without a vendor, and offers that write themselves.
--
-- PandaDoc's API is only on plans that include it, so CLOZR gets its own
-- contract engine: document templates (system ones seeded here, workspace
-- overrides on top), a signer table with one-time signing tokens, the signed
-- PDF in private storage, and an audit trail. The `contracts` table from 26
-- stays the single list; `provider` says which engine produced a row.
--
-- Offers: an outbound offer to a seller records the number on the deal and
-- moves the seller to Offer Made, so "generate offer" is one insert.

-- ---------------------------------------------------------------- templates
create table if not exists public.doc_templates (
  id            bigint generated always as identity primary key,
  workspace_id  bigint references public.workspaces(id) on delete cascade,   -- null = system template
  key           text not null,
  name          text not null,
  kind          text not null default 'other'
    check (kind in ('psa','assignment','amendment','termination','option','novation','jv','disclosure','addendum','offer','other')),
  body_md       text not null,
  signers       jsonb not null default '[]'::jsonb,   -- [{ role, label, party: seller|seller2|buyer|company, optional }]
  sort          integer not null default 100,
  active        boolean not null default true,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists doc_templates_key_idx on public.doc_templates (coalesce(workspace_id, 0), key);
alter table public.doc_templates enable row level security;
drop policy if exists doc_templates_select on public.doc_templates;
create policy doc_templates_select on public.doc_templates for select
  using (workspace_id is null or public.is_workspace_member(workspace_id));
drop policy if exists doc_templates_write on public.doc_templates;
create policy doc_templates_write on public.doc_templates for all
  using (workspace_id is not null and public.has_role(workspace_id, 'owner','admin'))
  with check (workspace_id is not null and public.has_role(workspace_id, 'owner','admin'));
drop trigger if exists doc_templates_touch on public.doc_templates;
create trigger doc_templates_touch before update on public.doc_templates for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- contracts
alter table public.contracts
  add column if not exists provider     text not null default 'pandadoc',
  add column if not exists template_key text,
  add column if not exists body_md      text,
  add column if not exists pdf_path     text,
  add column if not exists sha256       text,
  add column if not exists offer_id     bigint references public.offers(id) on delete set null,
  add column if not exists expires_at   timestamptz,
  add column if not exists message      text;
alter table public.contracts drop constraint if exists contracts_provider_check;
alter table public.contracts add constraint contracts_provider_check check (provider in ('pandadoc','clozr'));
alter table public.contracts drop constraint if exists contracts_kind_check;
alter table public.contracts add constraint contracts_kind_check
  check (kind in ('psa','assignment','amendment','termination','option','novation','jv','disclosure','addendum','offer','other'));

create table if not exists public.contract_signers (
  id             bigint generated always as identity primary key,
  workspace_id   bigint not null references public.workspaces(id) on delete cascade,
  contract_id    bigint not null references public.contracts(id) on delete cascade,
  role           text not null,
  label          text,
  name           text,
  email          text,
  phone          text,
  sort           integer not null default 1,
  token          text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  status         text not null default 'pending' check (status in ('pending','viewed','signed','declined')),
  viewed_at      timestamptz,
  consented_at   timestamptz,
  signed_at      timestamptz,
  declined_at    timestamptz,
  decline_reason text,
  signature_name text,
  signature_png  text,              -- data URL of a drawn signature; read by the esign function only
  ip             text,
  user_agent     text,
  created_at     timestamptz not null default now()
);
create index if not exists contract_signers_contract_idx on public.contract_signers (contract_id, sort);
alter table public.contract_signers enable row level security;
drop policy if exists contract_signers_select on public.contract_signers;
create policy contract_signers_select on public.contract_signers for select using (public.is_workspace_member(workspace_id));
-- Writes only through the contracts / esign functions (service role).

-- ------------------------------------------------------------------ offers
alter table public.offers
  add column if not exists seller_id   bigint references public.sellers(id) on delete cascade,
  add column if not exists basis       text,
  add column if not exists expires_on  date,
  add column if not exists contract_id bigint references public.contracts(id) on delete set null,
  add column if not exists terms       jsonb;
create index if not exists offers_seller_idx on public.offers (seller_id, sent_at desc);

-- An outbound offer to a seller is the deal's offer amount, and the seller is
-- now in Offer Made (never pulled backwards past an offer stage).
create or replace function public.offers_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare cur_sort integer;
begin
  if pg_trigger_depth() > 1 or new.direction <> 'outbound' or new.seller_id is null then return new; end if;
  if new.deal_id is not null and new.amount is not null then
    update public.deals set offer_amount = new.amount, updated_at = now() where id = new.deal_id;
  end if;
  if tg_op = 'INSERT' then
    select s.sort into cur_sort from public.sellers x join public.seller_stages s on s.label = x.lead_stage where x.id = new.seller_id;
    if cur_sort is null or cur_sort < 130 then
      update public.sellers set lead_stage = 'Offer Made' where id = new.seller_id;
    end if;
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
    values (new.workspace_id, 'seller', new.seller_id, 'offer',
            'Offer ' || coalesce(to_char(new.amount, 'FM$999,999,999'), '—') || coalesce(' · ' || new.basis, ''),
            coalesce(new.notes, ''), new.created_by);
  end if;
  return new;
end $$;
revoke execute on function public.offers_after_write() from public, anon, authenticated;
drop trigger if exists offers_after_write on public.offers;
create trigger offers_after_write after insert or update of amount, status on public.offers
  for each row execute function public.offers_after_write();

-- ----------------------------------------------------------------- storage
-- Signed PDFs live in a private bucket, one folder per workspace:
--   contracts/ws/<workspace_id>/<contract_id>/<file>.pdf
-- Members read their workspace's folder; only the functions write.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('contracts', 'contracts', false) on conflict (id) do nothing;
    execute 'drop policy if exists contracts_read on storage.objects';
    execute $p$create policy contracts_read on storage.objects for select to authenticated
      using (bucket_id = 'contracts' and split_part(name, '/', 1) = 'ws'
             and public.is_workspace_member(nullif(split_part(name, '/', 2), '')::bigint))$p$;
  end if;
end $$;

-- ------------------------------------------------------------- templates
-- System templates. Tokens are [Group.Name]; {{sign:role}} places a signature
-- block; "---" starts a new page. The company's own language, with the parties
-- as tokens so one template serves every deal.
insert into public.doc_templates (workspace_id, key, name, kind, sort, signers, body_md) values
(null, 'psa', 'Agreement to Buy and Sell Real Estate', 'psa', 10,
 '[{"role":"seller","label":"Seller","party":"seller"},{"role":"seller2","label":"Seller 2","party":"seller2","optional":true},{"role":"buyer","label":"Buyer","party":"company"}]',
$body$###### [Company.Name]
[Company.Address]

# AGREEMENT TO BUY AND SELL REAL ESTATE

This is a legally binding contract written in plain English. Plain language is just as enforceable as legal language. Please read all of it. If anything is unclear, ask us before you sign.

### THE BASICS

Date of this Agreement: [Date.Today]

Seller (the person or people selling): [Seller.Name]

Buyer (the company buying): [Company.Legal]

Property address: [Property.FullAddress]

Legal description: [Property.LegalDescription]

Purchase Price: [Deal.PurchasePrice]

How you get paid: This is an all-cash sale. The Purchase Price is your "Net to Seller" amount, adjusted for prorated property taxes. "Net to Seller" means what you walk away with after your own debts on the property are paid off. The full definition is later in this contract.

Closing costs: Buyer pays all closing costs. You pay none.

### EARNEST MONEY (THE GOOD-FAITH DEPOSIT)

Buyer will deposit Earnest Money of [Deal.EMD] with [Company.Legal], acting as escrow holder, within [Deal.EMDDays] days after the Effective Date. By signing, you agree that [Company.Legal] (an affiliate of Buyer) may hold the deposit and pay it out only as this contract says, and you waive any objection to Buyer or Buyer's affiliate holding it. The deposit stays in a separate escrow account and is never mixed with other funds.

### WHEN THIS CONTRACT STARTS AND WHEN WE CLOSE

This becomes a binding contract once both Buyer and Seller have signed. If Seller has not accepted and signed by this date, the contract is void.

Acceptance Deadline: [Deal.AcceptanceDeadline]

Closing happens on or before: [Deal.ClosingDate]

At this Title Company: [Deal.TitleCompany]

You authorize the title company to run all normal title, lien, and insurance checks. The deposit is handled only by the Earnest Money section above.

---

### INSPECTIONS

This contract depends on Buyer approving the property's condition before title transfers. You agree to give Buyer and Buyer's agents, contractors, invitees, or potential assignees access to inspect the property before closing. The inspection period starts the day after the Effective Date.

### PUBLIC NOTICE OF THIS CONTRACT

Buyer may record a short notice (a "Memorandum of Contract") in the county records. It tells the public that Buyer has an interest in this property under this contract. While this contract is active, you agree not to sell, transfer, or put new debt on the property in any way that interferes with Buyer's rights. If you do, Buyer can pursue every legal remedy available, including a court order and money damages. Buyer will only keep the notice recorded while this contract is in effect and Buyer is acting in good faith.

### IF SELLER BACKS OUT

If you refuse or fail to close as this contract requires, Buyer can ask a court to force the sale to go through ("specific performance") or sue for money damages. If either side goes to court to enforce this contract, the winner gets their attorney's fees and court costs paid by the loser.

### LIENS AND DEBTS ON THE PROPERTY

If liens, judgments, or other legal claims delay or block the closing, you agree to fully cooperate with Buyer to clear them. That may mean giving documents to the title company or paying off the debt. These debts are yours alone. Buyer does not have to lower the price because of them.

### IF BUYER CANCELS, THE DEPOSIT GOES BACK TO BUYER

If Buyer cancels using any contingency or cancellation right in this contract, the deposit goes back to Buyer immediately and unconditionally once Buyer delivers written notice. Your signature or consent is not needed. The escrow agent is instructed to release the deposit to Buyer on that notice, and you permanently waive any right to dispute it.

### TAXES AND RENT AT CLOSING

Property taxes are split based on this year's tax bill, with no discounts or exemptions (like homestead) factored in. Rents must be current and are split as of the day title transfers.

### PROPERTY CONDITION

The property is sold as-is, where-is. You state that you do not actually know of any hazardous substances or uncorrected code violations on the property. If the property is damaged before title transfers, Buyer can either take it as-is at an adjusted price, or cancel this contract.

### BUYER MAY ASSIGN THIS CONTRACT

Buyer may assign, sell, transfer, market, pledge, or otherwise convey its rights under this contract to someone else. Any assignment is for Buyer's own account and does not make Buyer your agent or broker.

### NO JUDGMENTS OR BANKRUPTCY

You promise there are no judgments threatening the equity in the property and no bankruptcy pending or planned by anyone on title. You will not add new debt against the property. Buyer may record an affidavit, at Buyer's expense, telling the public that this closing wipes out liens recorded after it.

### WE ARE NOT YOUR AGENT

Buyer, including any affiliate such as [Company.Legal], is buying this property for itself. Buyer is not your real estate broker, agent, advisor, or fiduciary, and this contract creates no agency relationship, express or implied. You waive any claim that Buyer owes you fiduciary duties, loyalty, advice, or disclosures beyond this contract. Buyer may hold a real estate license; a license does not make Buyer your agent in this deal.

### IF WE FIND PROBLEMS DURING INSPECTION

If Buyer finds defects, deferred maintenance, environmental issues, or other conditions during inspection that you did not disclose and that were not reasonably visible before signing, Buyer may notify you in writing. Both sides then negotiate in good faith to adjust the price, closing terms, or other provisions. A change only counts if both sides agree in writing. If no agreement is reached, Buyer may cancel under the inspection contingency and get the deposit back.

### IF SOMETHING KNOWN WAS NOT DISCLOSED

You state that you have disclosed every known material defect or adverse condition that would reasonably affect what Buyer would pay or whether Buyer would buy. If Buyer learns during inspection that a known defect was hidden or the condition was misrepresented, Buyer may either (a) renegotiate the price or terms to match the property's real condition, or (b) cancel and get the deposit back. A price adjustment requested under this section is a contract remedy, not a breach by Buyer.

### HOW RENEGOTIATION WORKS

Any renegotiation request comes in writing and may include inspection reports, photos, contractor estimates, or similar documentation. You have 2 days to respond. If the two sides cannot agree, Buyer does not have to go forward at the original price.

### WHAT "NET TO SELLER" MEANS

"Net to Seller" is what you receive from the Purchase Price after your own obligations on the property are paid, including but not limited to:

- Mortgages, deeds of trust, and other liens
- Judgments and recorded encumbrances
- Unpaid property taxes and assessments
- HOA dues, transfer fees, resale certificates, fines, violations, and liens
- City, code enforcement, or other government liens
- Utility balances from your time of ownership
- Any other cost normally or legally charged to a seller where the property is located

Buyer is not responsible for any of your debts or obligations unless this contract clearly says otherwise.

---

### YOUR RIGHT TO SELL

You promise that you (a) lawfully own the property or are legally authorized to transfer title, (b) have full legal capacity and authority to sign and perform this contract, and (c) are not blocked from selling by any law, court order, bankruptcy, probate restriction, guardianship, or other contract. You also promise that everyone whose signature is legally required to transfer title has signed or will sign this contract and all closing documents. You agree to cover Buyer's losses, delays, and expenses, including attorney's fees, caused by you lacking the authority or ability to legally transfer title.

### HOMEOWNERS ASSOCIATION (HOA)

You will state whether the property is in an HOA, condo association, or similar group. If it is, you pay in full at or before closing all HOA costs, including transfer fees, resale certificate fees, unpaid assessments, special assessments, fines, violations, and liens. Buyer will not reduce the price for these costs. You agree to promptly work with the HOA and title company to clear all HOA matters.

### TENANTS AND LEASES

You will state whether tenants occupy the property. If it is leased, you must give Buyer, within 3 calendar days of the Effective Date, true and complete copies of all written leases, any amendments, a current rent roll, and security deposit amounts. Missing that deadline is a material breach and lets Buyer cancel this contract or push back closing, at Buyer's sole choice.

### NO SIDE DEALS

While this contract is active, you will not solicit, negotiate, accept, or sign any other deal to sell or put debt on the property. Doing so is a material breach.

### SELLER COVERS BUYER'S LOSSES

You will protect and reimburse Buyer, including [Company.Legal], for any claims, losses, damages, costs, or expenses, including reasonable attorney's fees, that come from:

- You breaking this contract
- You misrepresenting anything
- You lacking the authority to sell
- You failing to close

If either side sues to enforce this contract, the winner recovers reasonable attorney's fees and court costs.

### POSSESSION

Buyer takes possession when title transfers, including all keys and garage door openers. Tenants with leases stay; their leases and security deposits transfer to Buyer with the title.

### OTHER AGREEMENTS

[Deal.OtherAgreements]

---

# FINAL TERMS

Governing law: This contract is governed by the law of the state where the property is located. Entire agreement: This document is the complete agreement and replaces all earlier discussions. Changes only count in writing, signed by both sides.

Deadlines matter: Time is of the essence. Every contingency must be satisfied or waived by its deadline. If needed to satisfy an outstanding contingency, this contract may be extended up to 5 business days. The inspection contingency ends on the earlier of Buyer's written approval or Buyer's written cancellation, and no extension revives it unless both sides expressly agree in writing.

# SIGNATURES

By signing, each party confirms they have read this entire contract, understand it, and agree to be bound by it.

{{sign:seller}}

{{sign:seller2}}

{{sign:buyer}}
$body$),

(null, 'assignment', 'Assignment Agreement', 'assignment', 20,
 '[{"role":"assignor","label":"Assignor","party":"company"},{"role":"assignee","label":"Assignee","party":"buyer"}]',
$body$###### [Company.Name]
[Company.Address]

# ASSIGNMENT AGREEMENT

This Assignment Agreement ("Agreement") is entered into as of [Date.Today] (Effective Date), by and between:

Assignor: [Company.Legal]

Assignee: [Buyer.Company]

Property: [Property.FullAddress]

Assignor hereby assigns to Assignee all of Assignor's rights, title, and interest in and to that certain Real Estate Purchase Agreement ("Underlying Contract") by and between Assignor (as buyer) and Original Seller (as seller), for the purchase of the above-referenced Property ("Property").

### 1. CONSIDERATION & PAYMENT TERMS

- 1.1 Total Consideration. As consideration for this Assignment, Assignee agrees to pay a total amount of [Deal.AssignmentPrice] (Purchase Price + Assignment Fee), which amount represents the aggregate of the purchase price under the Purchase Agreement and any additional consideration due to Assignor.
- 1.2 Earnest Money Deposit (EMD). Assignee shall deposit [Deal.BuyerEMD] with the title company within one (1) business day of execution. This EMD is non-refundable after the Termination Period unless Seller cannot provide clear, marketable title.
- 1.3 No Reduction of Assignment Consideration. No adjustments, deductions, or chargebacks related to seller concessions, seller-paid closing costs, title company fees, escrow charges, or any other settlement expenses shall reduce Assignor's assignment consideration.
- 1.4 Assignee Payment Obligation. In the event settlement proceeds are insufficient to cover all costs, Assignee shall remain directly liable to Assignor for the full amount of assignment consideration, which obligation shall survive Closing.
- 1.5 Payment at Closing. Assignment consideration shall be paid in full at Closing and disbursed directly by the title company.
- 1.6 Settlement Statement. The assignment fee shall be included on the settlement statement as "Assignment Fee."
- 1.7 Non-Refundability. Assignment consideration becomes non-refundable after expiration of the Termination Period.
- 1.8 Transaction Coordination Fee. Assignee agrees to pay a Transaction Coordination (TC) fee in the amount of [Deal.TCFee] as part of closing costs. This fee shall be reflected on the settlement statement and paid at Closing to the transaction coordinator or Assignor's designated payee and is non-refundable upon Closing.

### 2. TERMINATION PERIOD

- 2.1 No Contingency Periods. There shall be no option period, inspection period, financing contingency, or appraisal contingency.
- 2.2 Limited Cancellation Rights. Assignee waives all rights to cancel except as expressly provided under Section 4 (Title and Closing).
- 2.3 Due Diligence Responsibility. All due diligence shall be conducted at Assignee's sole expense, and Assignor shall not be required to provide inspections, access, or documentation beyond what was received from the Original Seller.

### 3. NO CONTINGENCIES / AS-IS

- 3.1 No Financing or Inspection Contingencies. This Assignment is not contingent on inspections, appraisals, or financing of any kind.
- 3.2 As-Is Purchase. Assignee agrees that they are purchasing the interest in the contract as-is, where-is, based solely on their own due diligence.
- 3.3 No Assignor Warranties. Assignor makes no warranties as to the condition of the Property or Original Seller's performance.
- 3.4 Single Inspection Right. Assignee shall be permitted one (1) inspection of the Property, coordinated through Assignor. This inspection shall not serve as a contingency to Closing and shall not permit renegotiation.
- 3.5 Appraisal / Loan Funding. If Assignee's lender or hard money lender appraisal returns a value lower than the Purchase Price, Assignee agrees to bring the difference in cash to Closing. Assignor shall not reduce the purchase price or assignment consideration under any circumstances.

### 4. TITLE AND CLOSING

- 4.1 Closing Date. Closing shall occur on or before [Deal.ClosingDate].
- 4.2 Title Company. Assignee shall use [Deal.TitleCompany] title company.
- 4.3 Delivery of Documents. Assignor shall deliver to Assignee all documents from Original Seller necessary to close.
- 4.4 Automatic Extension. If Closing is delayed due to title curative requirements, Original Seller performance, or matters not attributable to Assignor or Assignee, the Closing Date shall automatically extend for the period reasonably necessary to cure such matters.
- 4.5 Failure of Marketable Title. If the Original Seller cannot convey marketable and insurable title within ten (10) business days, this Agreement shall terminate and EMD shall be refunded unless amended in writing.
- 4.6 Assignee Delay Damages. If Closing is delayed due to Assignee's failure to perform, Assignee shall owe liquidated damages of $1,000 per day until Closing occurs.
- 4.7 Tenant Vacate Provision. Assignor represents tenants, if any, shall vacate prior to Closing. Assignee accepts responsibility for enforcement thereafter.

---

### 5. NON-DISCLOSURE OF ASSIGNMENT FEE

- 5.1 Confidentiality. Assignee agrees not to disclose the assignment fee or structure to any third party including the Original Seller or agents.
- 5.2 Title Company Restriction. Title company shall not disclose the assignment fee outside the settlement statement without Assignor's written approval.

### 6. NON-CIRCUMVENTION & NON-MARKETING

- 6.1 Anti-Circumvention. Assignee shall not contact, negotiate with, or deal with the Original Seller or related parties in a manner that circumvents Assignor.
- 6.2 Marketing Restriction. Assignee shall not market, advertise, or solicit buyers without Assignor's written consent.
- 6.3 Daisy-Chaining Prohibition. Unauthorized marketing constitutes material breach entitling Assignor to termination, forfeiture of deposits, injunctive relief, and damages.
- 6.4 Survival. These obligations survive Closing.

### 7. INDEMNIFICATION

- 7.1 Assignee Indemnity. Assignee agrees to hold harmless and indemnify Assignor from claims arising from: (a) Assignee's failure to close or perform; (b) disputes with the Original Seller; (c) third-party claims resulting from Assignee breach; (d) unauthorized marketing or circumvention.

### 8. ENFORCEMENT & REMEDIES

- 8.1 Attorney's Fees. The prevailing party shall recover reasonable attorneys' fees and costs.
- 8.2 Liquidated Damages. Assignor may retain deposits and consideration paid as liquidated damages in addition to other remedies.
- 8.3 Specific Performance. Assignor shall be entitled to seek specific performance compelling Assignee to close.
- 8.4 Personal Liability. If Assignee is an entity, the signatory personally guarantees obligations.
- 8.5 Survival. All obligations including payment, indemnification, confidentiality, and non-circumvention survive Closing or termination.
- 8.6 Time is of the Essence. Time is of the essence with respect to funding, document execution, and Closing.
- 8.7 Recording Restriction. Assignee shall not record this Agreement or any memorandum without Assignor's written consent.
- 8.8 Liquidated Damage Acknowledgment. Assignee acknowledges Assignor will incur substantial damages if Assignee fails to close and agrees liquidated damages are reasonable and not a penalty.
- 8.9 Third-Party Liability Disclaimer. Assignor shall not be liable for acts, omissions, defaults, or performance failures of the Original Seller or third parties.
- 8.10 Assignment Fee Earned. Assignor's assignment fee shall be deemed earned upon expiration of the Termination Period and shall not be contingent upon Assignee resale, financing, profitability, or investment outcome.

### 9. ENTIRE AGREEMENT / MODIFICATIONS

- 9.1 Entire Agreement. This Agreement represents the entire agreement between Assignor and Assignee.
- 9.2 Modifications. Any changes must be in writing and signed by both parties.

### 10. GOVERNING LAW

- 10.1 Governing Law. This Agreement shall be governed by the laws of the State of [Property.State].

### 11. ELECTRONIC SIGNATURES

- 11.1 Electronic Execution. This Agreement may be signed electronically and in counterparts and shall be legally binding.

### 12. SPECIAL AGREEMENTS SECTION

[Deal.SpecialAgreements]

---

# SIGNATURES

Assignor (Seller): [Company.Legal]

{{sign:assignor}}

Assignee (Buyer): [Buyer.Company]

{{sign:assignee}}
$body$),

(null, 'termination', 'Real Estate Purchase Agreement Termination', 'termination', 30,
 '[{"role":"buyer","label":"Buyer","party":"company"},{"role":"seller","label":"Seller","party":"seller","optional":true}]',
$body$###### [Company.Name]
[Company.Address]

# REAL ESTATE PURCHASE AGREEMENT TERMINATION

This Termination Agreement ("Termination") is entered into effective as of the date signed below, by and between the undersigned Buyer ("Buyer") and relates to the Real Estate Purchase Agreement ("Agreement") previously entered into for the purchase of the property described below:

Property Address: [Property.FullAddress]

Seller Name: [Seller.Name]

Original Contract Date: [Deal.ContractDate]

# Termination of Agreement

Buyer hereby provides written notice of termination of the Agreement. Buyer and Seller mutually agree to release one another from any further obligations, liabilities, or claims arising out of the Agreement, except for any provisions that expressly survive termination as stated in the Agreement.

As part of this Termination, the parties agree to the following regarding the Earnest Money Deposit ("EMD"):

- The Buyer shall receive a full return of the EMD.
- The Seller forfeits any claim to the EMD and waives any right to dispute the release of funds to the Buyer.

This Termination shall be governed by the laws of the State of [Property.State].

# Executed by Buyer

{{sign:buyer}}

{{sign:seller}}
$body$),

(null, 'offer_letter', 'Cash Offer Letter', 'offer', 5,
 '[{"role":"buyer","label":"Buyer","party":"company"},{"role":"seller","label":"Seller","party":"seller"}]',
$body$###### [Company.Name]
[Company.Address]

# CASH OFFER

[Date.Today]

Dear [Seller.FirstName],

Thank you for the opportunity to look at [Property.FullAddress]. Based on the condition of the property and recent sales in the area, [Company.Legal] is pleased to make the following offer.

### THE OFFER

Purchase price (net to you): [Offer.Amount]

Earnest money deposit: [Offer.EMD]

Closing: on or before [Offer.CloseDays] days after acceptance, at a title company of Buyer's choosing

Closing costs: Buyer pays all closing costs. You pay none.

Condition: as-is, where-is. No repairs, no cleaning out, no showings.

Offer valid through: [Offer.Expires]

### WHAT HAPPENS NEXT

If these terms work for you, sign below and we will send the full purchase agreement for signature the same day. Nothing here obligates you until that purchase agreement is signed by both sides. If the numbers are not quite right, call or text [Company.Signer] at [Company.Phone] and we will work through it together.

We appreciate your time and look forward to working with you.

[Company.Signer], [Company.Title]
[Company.Legal]

# ACCEPTANCE

{{sign:seller}}

{{sign:buyer}}
$body$)
on conflict do nothing;
