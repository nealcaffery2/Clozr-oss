-- 75: the default paperwork, in the engine that fills and signs it.
--
-- Generate Offer used to write a "field packet" for someone to paste into
-- PandaDoc by hand, which filled nothing and sent nobody anywhere. The
-- built-in engine (contracts + esign + /sign) was still there, with the PSA,
-- the assignment, the termination and the cash offer letter already written
-- as templates. This migration adds the rest of the paperwork stack so every
-- document the TC sends is one CLOZR fills from the record, and flips the
-- default engine back to it.
--
-- A body is markdown-ish: [Group.Name] tokens the record answers, {{sign:role}}
-- where a signature goes, `---` for a page break. A token the record cannot
-- answer becomes a fill-in on the New contract form instead of a silent blank.

-- The escrow holder is named in the PSA and in the addenda. It is usually the
-- buyer's own affiliate, so it gets its own setting rather than borrowing the
-- legal entity's name.
update public.doc_templates
   set body_md = replace(body_md,
     'Buyer will deposit Earnest Money of [Deal.EMD] with [Company.Legal], acting as escrow holder, within [Deal.EMDDays] days after the Effective Date. By signing, you agree that [Company.Legal] (an affiliate of Buyer)',
     'Buyer will deposit Earnest Money of [Deal.EMD] with [Company.Escrow], acting as escrow holder, within [Deal.EMDDays] days after the Effective Date. By signing, you agree that [Company.Escrow] (an affiliate of Buyer)')
 where workspace_id is null and key = 'psa';

insert into public.doc_templates (workspace_id, key, name, kind, sort, signers, body_md) values

-- ------------------------------------------------------------ authorization
(null, 'authorization', 'Authorization to Sign Listing Docs and Offers', 'disclosure', 15,
 '[{"role":"seller","label":"Seller","party":"seller"},{"role":"seller2","label":"Seller 2","party":"seller2","optional":true}]',
$body$###### [Company.Name]
[Company.Address]

# AUTHORIZATION TO SIGN LISTING DOCS AND OFFERS

BE IT ACKNOWLEDGED that I/we, [Seller.Name] ("Seller"), do hereby grant a limited and specific authorization to [Company.Signer] with [Company.Legal], located at [Company.Address], as my Attorney-in-Fact.

Said Attorney-in-Fact shall have full power and authority to undertake and perform the following acts on my behalf, related to the property located at [Property.FullAddress] (the "Property").

### WHAT THE ATTORNEY-IN-FACT IS AUTHORIZED TO DO

Seller specifically authorizes and gives permission to the Attorney-in-Fact to list the Property on any and all Multiple Listing Services (MLS) for the purpose of marketing, clearing title, and selling the Property. This includes executing listing agreement(s), listing agreement addendum(s), disclosures, sales contracts, title commitments, settlement statements, receiving payoffs from banks, judgments, or any liens, communicating with lenders, and addendums. The authority herein shall include such incidental acts as are reasonably required to carry out the authorities granted herein.

### WHEN THIS AUTHORIZATION STARTS AND ENDS

This authorization is effective upon execution.

This authorization may be revoked when the above-stated power or responsibility has been completed.

This authorization shall automatically be revoked upon my death or incapacitation, provided any person relying on this power of attorney shall have full rights to accept and rely upon the authority of the Attorney-in-Fact until the receipt of actual notice of revocation.

# SIGNATURES

{{sign:seller}}

{{sign:seller2}}
$body$),

-- ----------------------------------------------------------------- amendment
(null, 'amendment', 'Amendment to Contract', 'amendment', 25,
 '[{"role":"seller","label":"Seller","party":"seller"},{"role":"seller2","label":"Seller 2","party":"seller2","optional":true},{"role":"buyer","label":"Buyer","party":"company"}]',
$body$###### [Company.Name]
[Company.Address]

# AMENDMENT

TO CONTRACT CONCERNING THE PROPERTY AT [Property.FullAddress]

Seller and Buyer amend the contract dated [Deal.ContractDate] as follows. Only the paragraphs completed below are amended; everything else in the contract stays as written.

### (1) THE SALES PRICE OF THE CONTRACT IS

A. Cash portion of Sales Price payable by Buyer at closing: [Amend.CashPortion]

B. Sum of financing described in the contract: [Amend.Financing]

C. Sales Price (Sum of A and B): [Amend.SalesPrice]

### (2) REPAIRS AND TREATMENTS

In addition to any repairs and treatments otherwise required by the contract, Seller, at Seller's expense, shall complete the following repairs and treatments: [Amend.Repairs]

### (3) CLOSING DATE

The closing date of the contract is changed to [Amend.ClosingDate]

### (4) OPTION FEE

Buyer waives the unrestricted right to terminate the contract for which the Option Fee was paid: [Amend.OptionWaiver]

### (5) OTHER MODIFICATIONS

(Insert only factual statements and business details applicable to this sale.)

[Amend.Other]

# EXECUTED

{{sign:buyer}}

{{sign:seller}}

{{sign:seller2}}
$body$),

-- -------------------------------------------------------------------- option
(null, 'option', 'Non-Exclusive Option to Purchase Agreement', 'option', 35,
 '[{"role":"optionor","label":"Optionor (Seller)","party":"seller"},{"role":"optionee","label":"Optionee (Buyer)","party":"company"}]',
$body$###### [Company.Name]
[Company.Address]

# NON-EXCLUSIVE OPTION TO PURCHASE AGREEMENT

This Option Agreement is made between the following parties:

1. [Seller.Name], hereinafter referred to as "Optionor"; and

2. [Company.Legal], hereinafter referred to as "Optionee".

The following terms are applicable to this agreement:

A. The Optionor agrees to grant an option to purchase to the Optionee, the land and the improvements known as [Property.FullAddress].

B. Optionor agrees that he/she will not attempt to enter into any other negotiations or terms for sale of this property with any other party while this agreement is in effect. If Optionor receives any other independent offers on this property, Optionee shall be notified immediately.

C. Upon agreement, the option would begin on [Option.Start] and end on the date of [Option.End].

D. The purchase price will be [Option.Price] payable by certified funds at settlement.

E. Optionor grants Optionee access to the above property for showing to prospective buyers, contractors, or appraisers.

F. Optionor must maintain proper insurance on the before-mentioned property.

G. If the Optionee purchases the property, closing cost will be paid by [Option.ClosingCostsBy].

H. Optionor grants this option for the consideration of ten dollars ($10.00) payable to the settlement agent when exercising this option.

I. This option contract is assignable by the Optionee. Optionee has the express consent of the Optionor to market this property to Optionee's investor partners and prospective buyers.

J. Buyer is a real estate licensee and is acting as a principal party in this transaction: [Option.LicenseeStatus]

# AGREED

{{sign:optionor}}

{{sign:optionee}}
$body$),

-- ----------------------------------------------------------------- leaseback
(null, 'leaseback', 'Temporary Leaseback Addendum', 'addendum', 40,
 '[{"role":"seller","label":"Seller (Tenant)","party":"seller"},{"role":"seller2","label":"Seller 2","party":"seller2","optional":true},{"role":"buyer","label":"Buyer (Landlord)","party":"company"}]',
$body$###### [Company.Name]
[Company.Address]

# TEMPORARY LEASEBACK ADDENDUM

This Temporary Leaseback Addendum ("Addendum") is entered into on [Date.Today] and shall be deemed incorporated into the Agreement dated [Deal.ContractDate] between:

Seller (Tenant): [Seller.Name]

Buyer (Landlord): [Company.Legal]

Property Address: [Property.FullAddress]

### 1. PURPOSE

Seller shall remain in possession of the property for a limited time after the closing date. This Addendum sets forth the terms and conditions of that occupancy.

### 2. LEASE TERM

The leaseback shall begin on the Closing Date: [Deal.ClosingDate] and end on Move-Out Date: [Lease.MoveOut] (the "Lease Term"). If no date is stated, Seller shall vacate within [Lease.Days] calendar days following the Closing Date.

### 3. RENT AND DEPOSIT

- Daily Rent Amount: [Lease.DailyRent] per day
- Total Rent Due at Closing: [Lease.TotalRent]
- Security Deposit (if any): [Lease.Deposit]

Rent and any deposit shall be collected and held by the Title Company or disbursed directly to Buyer at closing, as instructed.

### 4. USE AND OCCUPANCY

- Seller may use the Property for residential purposes only during the Lease Term.
- Seller shall maintain the Property in its current condition and shall not cause damage or make alterations.
- Seller shall not sublease or allow additional occupants without Buyer's written consent.

### 5. UTILITIES

Seller shall be responsible for all utilities and services during the Lease Term, unless otherwise agreed in writing.

### 6. CONDITION UPON MOVE-OUT

Seller shall vacate the Property on or before the Move-Out Date, leaving it broom clean and free of trash and personal items. Buyer may withhold a portion or all of the deposit (if collected) for damages, cleaning, or days held over.

### 7. HOLDOVER

If Seller remains in possession beyond the Lease Term without Buyer's written consent:

- Seller shall pay [Lease.Holdover] per day as holdover rent;
- Buyer may pursue legal eviction and recover damages including attorney's fees and court costs.

### 8. INSURANCE AND LIABILITY

Buyer is not responsible for injury, loss, or damage to Seller or Seller's property. Seller agrees to indemnify and hold harmless Buyer from any claims arising from occupancy during the Lease Term.

### 9. BINDING EFFECT

This Addendum is binding upon the parties, their heirs, representatives, successors, and assigns. In the event of conflict with the main Agreement, the terms of this Addendum shall control as to leaseback matters.

# SIGNATURES

{{sign:seller}}

{{sign:seller2}}

{{sign:buyer}}
$body$),

-- ----------------------------------------------------------- escrow holdback
(null, 'escrow_holdback', 'Escrow Hold Back Addendum', 'addendum', 45,
 '[{"role":"seller","label":"Seller","party":"seller"},{"role":"seller2","label":"Seller 2","party":"seller2","optional":true},{"role":"buyer","label":"Buyer","party":"company"},{"role":"escrow","label":"Escrow / Title","optional":true}]',
$body$###### [Company.Name]
[Company.Address]

# ESCROW HOLD BACK ADDENDUM

This Escrow Hold Back Addendum ("Addendum") is entered into as of [Date.Today] and shall be deemed incorporated into and made part of the Purchase and Sale Agreement ("Agreement") dated [Deal.ContractDate] by and between the undersigned parties regarding the property located at:

Property Address: [Property.FullAddress]

Seller: [Seller.Name]

Buyer: [Company.Legal]

### 1. PURPOSE OF HOLDBACK

The parties agree that a portion of the proceeds due to Seller at closing shall be withheld in escrow to ensure the completion of the following: [Holdback.Purpose]

### 2. HOLDBACK AMOUNT

The amount of [Holdback.Amount] ("Holdback Funds") shall be withheld from Seller's proceeds at closing and held in escrow by [Holdback.Escrow], of [Holdback.Address].

### 3. RELEASE OF HOLDBACK

The Holdback Funds shall be released upon satisfactory completion of the following condition(s), to be verified by [Holdback.VerifiedBy]:

[Holdback.Conditions]

Deadline for completion: [Holdback.Deadline]

If conditions are not satisfied by the above deadline, the Buyer may direct the Holdback Funds to be (a) released back to the Buyer, or (b) applied toward correcting or completing the outstanding items.

### 4. ESCROW AUTHORIZATION

The Title Company or Attorney listed above is hereby instructed and authorized to hold and disburse the Holdback Funds as specified herein, without further instruction unless agreed in writing by both Buyer and Seller.

### 5. BINDING EFFECT

This Addendum shall be binding upon and inure to the benefit of the parties and their respective heirs, legal representatives, successors, and assigns.

# SIGNATURES

{{sign:seller}}

{{sign:seller2}}

{{sign:buyer}}

{{sign:escrow}}
$body$)
on conflict (coalesce(workspace_id, 0), key) do update
  set name = excluded.name, kind = excluded.kind, sort = excluded.sort,
      signers = excluded.signers, body_md = excluded.body_md, active = true;

-- --------------------------------------------------------- seller info sheet
-- The title company's intake form. CLOZR fills what the record knows; the rest
-- are fill-ins on the New contract form. Dates of birth and Social Security
-- numbers are deliberately printed as blank lines rather than tokens: they
-- would otherwise be stored on the contract row, and the title company is the
-- one who should be collecting them.
insert into public.doc_templates (workspace_id, key, name, kind, sort, signers, body_md) values
(null, 'seller_info', 'Seller Information Sheet', 'disclosure', 50,
 '[{"role":"seller","label":"Seller 1","party":"seller"},{"role":"seller2","label":"Seller 2","party":"seller2","optional":true}]',
$body$###### [Company.Name]
[Company.Address]

# SELLER INFORMATION SHEET

File number: [Title.File]

Property Address: [Property.FullAddress]

### SELLER MARITAL STATUS

[Seller.Marital]

(One of: married - both sellers shown are married to one another; married - spouse's full legal name; single when the property was acquired and remained single; married when acquired, divorced on a date and county/state of filing; married when acquired, marriage ended in death of spouse on a date; or none of the above, explained. Contact the escrow officer if none applies.)

### SELLER CONTACT INFORMATION

Seller 1 legal name: [Seller.Name]

Phone: [Seller.Phone]     Email: [Seller.Email]

Date of birth: ______________________     SS#: ______________________

Seller 2 legal name: [Seller2.Name]

Phone: [Seller2.Phone]     Email: [Seller2.Email]

Date of birth: ______________________     SS#: ______________________

Forwarding address: [Seller.Forwarding]

### SURVEY AND T-47 AFFIDAVIT

Do you have an existing survey? [Seller.HasSurvey]

If yes, please email a copy to your escrow officer. We will send you a T-47 Affidavit to complete regarding any changes to the property since the original survey. Both documents will be needed to complete survey review. If no, a new survey may need to be ordered.

### HOMEOWNERS ASSOCIATION (HOA)

Does the property have a Home Owner's Association? [HOA.Exists]

HOA name: [HOA.Name]

HOA management company: [HOA.Manager]

Contact information: [HOA.Contact]

Is there more than one HOA? [HOA.More]

Are all sellers in this transaction United States citizens? [Seller.Citizens]

If no, please reach out to your escrow officer for additional instructions.

### EXISTING LIENS ON THE PROPERTY / PAYOFF AUTHORIZATION

So that the title company may order loan payoff information.

1st lien - lender: [Lien1.Lender] · loan number: [Lien1.Loan] · contact: [Lien1.Contact] · description: [Lien1.Description]

2nd lien - lender: [Lien2.Lender] · loan number: [Lien2.Loan] · contact: [Lien2.Contact] · description: [Lien2.Description]

3rd lien - lender: [Lien3.Lender] · loan number: [Lien3.Loan] · contact: [Lien3.Contact] · description: [Lien3.Description]

### PAYOFF REQUEST AND AUTHORIZATION

By signing below, I/we authorize my/our mortgage company(ies) to release payoff information to the title company processing this transaction.

Property Address: [Property.FullAddress]

Name: [Seller.Name] · Last 4 SS#: ____________

Name: [Seller2.Name] · Last 4 SS#: ____________

{{sign:seller}}

{{sign:seller2}}
$body$)
on conflict (coalesce(workspace_id, 0), key) do update
  set name = excluded.name, kind = excluded.kind, sort = excluded.sort,
      signers = excluded.signers, body_md = excluded.body_md, active = true;

-- --------------------------------------------------------------- TREC 20-19
-- The promulgated One to Four Family Residential Contract (Resale).
--
-- Two things to know about this one. The text is the promulgated text, but
-- CLOZR reflows it into its own typography, so what comes out is a rendering
-- of TREC No. 20-19 and not the promulgated PDF itself -- for a filing that
-- must be on the TREC form, use TREC's own PDF. And because a signing page
-- cannot tick a box, every "check one box only" in the form is a token the
-- coordinator answers on the New contract form, which is also what makes the
-- choice show up filled in on the signed document.
insert into public.doc_templates (workspace_id, key, name, kind, sort, signers, body_md) values
(null, 'trec_1_4', 'TREC One to Four Family Residential Contract (Resale)', 'psa', 12,
 '[{"role":"seller","label":"Seller","party":"seller"},{"role":"seller2","label":"Seller 2","party":"seller2","optional":true},{"role":"buyer","label":"Buyer","party":"company"}]',
$body$###### PROMULGATED BY THE TEXAS REAL ESTATE COMMISSION (TREC) - TREC NO. 20-19

# ONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)

###### NOTICE: Not For Use For Condominium Transactions. This is a rendering of TREC No. 20-19 prepared by [Company.Name]. Read it with your own attorney before signing.

### 1. PARTIES

The parties to this contract are [Seller.Name] (Seller) and [Company.Legal] (Buyer). Seller agrees to sell and convey to Buyer and Buyer agrees to buy from Seller the Property defined below.

### 2. PROPERTY

The land, improvements and accessories are collectively referred to as the Property.

A. LAND: Lot [Legal.Lot], Block [Legal.Block], [Legal.Addition] Addition, City of [Property.City], County of [Property.County], Texas, known as [Property.FullAddress] (address/zip code), or as described on attached exhibit.

B. IMPROVEMENTS: The house, garage and all other fixtures and improvements attached to the above-described real property, including without limitation, the following permanently installed and built-in items, if any: all equipment and appliances, valances, screens, shutters, awnings, wall-to-wall carpeting, mirrors, ceiling fans, attic fans, mail boxes, television antennas, mounts and brackets for televisions and speakers, heating and air-conditioning units, security and fire detection equipment, wiring, plumbing and lighting fixtures, chandeliers, water softener system, kitchen equipment, garage door openers, cleaning equipment, shrubbery, landscaping, outdoor cooking equipment, generators, and all other property attached to the above described real property.

C. ACCESSORIES: The following described related accessories, if any: window air conditioning units, stove, fireplace screens, curtains and rods, blinds, window shades, draperies and rods, door keys, mailbox keys, above ground pool, swimming pool equipment and maintenance accessories, artificial fireplace logs, security systems that are not fixtures, and controls for: (i) garage doors, (ii) entry gates, and (iii) other improvements and accessories. "Controls" includes Seller's transferable rights to the (i) software and applications used to access and control improvements or accessories, and (ii) hardware used solely to control improvements or accessories.

D. EXCLUSIONS: The following improvements and accessories will be retained by Seller and must be removed prior to delivery of possession: [Trec.Exclusions]

E. RESERVATIONS: Any reservation for oil, gas, or other minerals, water, timber, or other interests is made in accordance with an attached addendum.

### 3. SALES PRICE

A. Cash portion of Sales Price payable by Buyer at closing: [Trec.CashPortion]. The term "Cash portion of the Sales Price" does not include proceeds from borrowing of any kind or selling other real property except as disclosed in this contract.

B. Sum of all financing described in the attached Third Party Financing Addendum, Loan Assumption Addendum, or Seller Financing Addendum: [Trec.Financing]

C. Sales Price (Sum of A and B): [Trec.SalesPrice]

### 4. LEASES

Except as disclosed in this contract, Seller is not aware of any leases affecting the Property. After the Effective Date, Seller may not, without Buyer's written consent, create a new lease, amend any existing lease, or convey any interest in the Property. The following apply: [Trec.Leases]

A. RESIDENTIAL LEASES: The Property is subject to one or more residential leases and the Addendum Regarding Residential Leases is attached to this contract.

B. FIXTURE LEASES: Fixtures on the Property are subject to one or more fixture leases (for example, solar panels, propane tanks, water softener, security system) and the Addendum Regarding Fixture Leases is attached to this contract.

C. NATURAL RESOURCE LEASES: "Natural Resource Lease" means an existing oil and gas, mineral, geothermal, water, wind, or other natural resource lease affecting the Property to which Seller is a party. Either (1) Seller has delivered to Buyer a copy of all the Natural Resource Leases; or (2) Seller has not delivered to Buyer a copy of all the Natural Resource Leases, in which case Seller shall provide to Buyer a copy of all the Natural Resource Leases within 3 days after the Effective Date, and Buyer may terminate the contract within [Trec.ResourceLeaseDays] days after the date the Buyer receives all the Natural Resource Leases and the earnest money shall be refunded to Buyer.

---

### 5. EARNEST MONEY AND TERMINATION OPTION

A. DELIVERY OF EARNEST MONEY AND OPTION FEE: Within 3 days after the Effective Date, Buyer must deliver to [Trec.EscrowAgent] (Escrow Agent) at [Trec.EscrowAddress] (address): [Trec.EarnestMoney] as earnest money and [Trec.OptionFee] as the option fee. The earnest money and option fee shall be made payable to Escrow Agent and may be paid separately or combined in a single payment.

(1) Buyer shall deliver additional earnest money of [Trec.AdditionalEM] to Escrow Agent within [Trec.AdditionalEMDays] days after the Effective Date of this contract.

(2) If the last day to deliver the earnest money, option fee, or the additional earnest money falls on a Saturday, Sunday, or Legal Holiday, the time to deliver the earnest money, option fee, or the additional earnest money, as applicable, is extended until the end of the next day that is not a Saturday, Sunday, or Legal Holiday. "Legal Holiday" means a legal holiday described in Sections 662.003(a) and 662.003(b)(4) and (6), Texas Government Code.

(3) The amount(s) Escrow Agent receives under this paragraph shall be applied first to the option fee, then to the earnest money, and then to the additional earnest money.

(4) Buyer authorizes Escrow Agent to release and deliver the option fee to Seller at any time without further notice to or consent from Buyer, and releases Escrow Agent from liability for delivery of the option fee to Seller. The option fee will be credited to the Sales Price at closing.

B. TERMINATION OPTION: For nominal consideration, the receipt of which Seller acknowledges, and Buyer's agreement to pay the option fee within the time required, Seller grants Buyer the unrestricted right to terminate this contract by giving notice of termination to Seller within [Trec.OptionDays] days after the Effective Date of this contract (Option Period). Notices under this paragraph must be given by 5:00 p.m. (local time where the Property is located) by the date specified. If Buyer gives notice of termination within the time prescribed: (i) the option fee will not be refunded and Escrow Agent shall release any option fee remaining with Escrow Agent to Seller; and (ii) any earnest money will be refunded to Buyer.

C. FAILURE TO TIMELY DELIVER EARNEST MONEY: If Buyer fails to deliver the earnest money within the time required, Seller may terminate this contract or exercise Seller's remedies under Paragraph 15, or both, by providing notice to Buyer before Buyer delivers the earnest money.

D. FAILURE TO TIMELY DELIVER OPTION FEE: If no dollar amount is stated as the option fee or if Buyer fails to deliver the option fee within the time required, Buyer shall not have the unrestricted right to terminate this contract under this paragraph 5.

E. TIME: Time is of the essence for this paragraph and strict compliance with the time for performance is required.

### 6. TITLE POLICY AND SURVEY

A. TITLE POLICY: Seller shall furnish to Buyer at [Trec.TitlePolicyExpense] expense an owner policy of title insurance (Title Policy) issued by [Trec.TitleCompany] (Title Company) in the amount of the Sales Price, dated at or after closing, insuring Buyer against loss under the provisions of the Title Policy, subject to the promulgated exclusions (including existing building and zoning ordinances) and the following exceptions:

- (1) Restrictive covenants common to the platted subdivision in which the Property is located.
- (2) The standard printed exception for standby fees, taxes and assessments.
- (3) Liens created as part of the financing described in Paragraph 3.
- (4) Utility easements created by the dedication deed or plat of the subdivision in which the Property is located.
- (5) Reservations or exceptions otherwise permitted by this contract or as may be approved by Buyer in writing.
- (6) The standard printed exception as to marital rights.
- (7) The standard printed exception as to waters, tidelands, beaches, streams, and related matters.
- (8) The standard printed exception as to discrepancies, conflicts, shortages in area or boundary lines, encroachments or protrusions, or overlapping improvements: [Trec.BoundaryException]
- (9) The exception or exclusion regarding minerals approved by the Texas Department of Insurance.

B. COMMITMENT: Within 20 days after the Title Company receives a copy of this contract, Seller shall furnish to Buyer a commitment for title insurance (Commitment) and, at Buyer's expense, legible copies of restrictive covenants and documents evidencing exceptions in the Commitment (Exception Documents) other than the standard printed exceptions. Seller authorizes the Title Company to deliver the Commitment and Exception Documents to Buyer at Buyer's address shown in Paragraph 21. If the Commitment and Exception Documents are not delivered to Buyer within the specified time, the time for delivery will be automatically extended up to 15 days or 3 days before the Closing Date, whichever is earlier. If the Commitment and Exception Documents are not delivered within the time required, Buyer may terminate this contract and the earnest money will be refunded to Buyer.

C. SURVEY: The survey must be made by a registered professional land surveyor acceptable to the Title Company and Buyer's lender(s). The parties choose: [Trec.Survey]

- (1) Within [Trec.SurveyDays] days after the Effective Date of this contract, Seller shall furnish to Buyer and Title Company Seller's existing survey of the Property and a Residential Real Property Affidavit or Declaration promulgated by the Texas Department of Insurance (T-47 Affidavit or T-47.1 Declaration). Buyer shall obtain a new survey at Seller's expense no later than 3 days prior to Closing Date if Seller fails to furnish within the time prescribed both the: (i) existing survey; and (ii) affidavit or declaration. If the Title Company or Buyer's lender does not accept the existing survey, or the affidavit or declaration, Buyer shall obtain a new survey at [Trec.NewSurveyExpense] expense no later than 3 days prior to Closing Date.
- (2) Within [Trec.SurveyDays] days after the Effective Date of this contract, Buyer may obtain a new survey at Buyer's expense. Buyer is deemed to receive the survey on the date of actual receipt or the date specified in this paragraph, whichever is earlier. If Buyer fails to obtain the survey, Buyer may not terminate the contract under Paragraph 2B of the Third Party Financing Addendum because the survey was not obtained.
- (3) Within [Trec.SurveyDays] days after the Effective Date of this contract, Seller, at Seller's expense shall furnish a new survey to Buyer.

D. OBJECTIONS: Buyer may object in writing to defects, exceptions, or encumbrances to title: disclosed on the survey other than items 6A(1) through (7) above; disclosed in the Commitment other than items 6A(1) through (9) above; or which prohibit the following use or activity: [Trec.ProhibitedUse]. Buyer must object the earlier of (i) the Closing Date or (ii) [Trec.ObjectionDays] days after Buyer receives the Commitment, Exception Documents, and the survey. Buyer's failure to object within the time allowed will constitute a waiver of Buyer's right to object; except that the requirements in Schedule C of the Commitment are not waived by Buyer. Provided Seller is not obligated to incur any expense, Seller shall cure any timely objections of Buyer or any third party lender within 15 days after Seller receives the objections (Cure Period) and the Closing Date will be extended as necessary. If objections are not cured within the Cure Period, Buyer may, by delivering notice to Seller within 5 days after the end of the Cure Period: (i) terminate this contract and the earnest money will be refunded to Buyer; or (ii) waive the objections. If Buyer does not terminate within the time required, Buyer shall be deemed to have waived the objections. If the Commitment or survey is revised or any new Exception Document(s) is delivered, Buyer may object to any new matter revealed in the revised Commitment or survey or new Exception Document(s) within the same time stated in this paragraph to make objections beginning when the revised Commitment, survey, or Exception Document(s) is delivered to Buyer.

E. TITLE NOTICES:

(1) ABSTRACT OR TITLE POLICY: Broker advises Buyer to have an abstract of title covering the Property examined by an attorney of Buyer's selection, or Buyer should be furnished with or obtain a Title Policy. If a Title Policy is furnished, the Commitment should be promptly reviewed by an attorney of Buyer's choice due to the time limitations on Buyer's right to object.

(2) MEMBERSHIP IN PROPERTY OWNERS ASSOCIATION(S): The Property [Trec.POA] subject to mandatory membership in a property owners association(s). If the Property is subject to mandatory membership in a property owners association(s), Seller notifies Buyer under Section 5.012, Texas Property Code, that, as a purchaser of property in the residential community identified in Paragraph 2A in which the Property is located, you are obligated to be a member of the property owners association(s). Restrictive covenants governing the use and occupancy of the Property and all dedicatory instruments governing the establishment, maintenance, or operation of this residential community have been or will be recorded in the Real Property Records of the county in which the Property is located. Copies of the restrictive covenants and dedicatory instruments may be obtained from the county clerk. You are obligated to pay assessments to the property owners association(s). The amount of the assessments is subject to change. Your failure to pay the assessments could result in enforcement of the association's lien on and the foreclosure of the Property. Section 207.003, Property Code, entitles an owner to receive copies of any document that governs the establishment, maintenance, or operation of a subdivision, including, but not limited to, restrictions, bylaws, rules and regulations, and a resale certificate from a property owners' association. A resale certificate contains information including, but not limited to, statements specifying the amount and frequency of regular assessments and the style and cause number of lawsuits to which the property owners' association is a party, other than lawsuits relating to unpaid ad valorem taxes of an individual member of the association. These documents must be made available to you by the property owners' association or the association's agent on your request. If Buyer is concerned about these matters, the TREC promulgated Addendum for Property Subject to Mandatory Membership in a Property Owners Association(s) should be used.

(3) STATUTORY TAX DISTRICTS: If the Property is situated in a utility or other statutorily created district providing water, sewer, drainage, or flood control facilities and services, Chapter 49, Texas Water Code, requires Seller to deliver and Buyer to sign the statutory notice relating to the tax rate, bonded indebtedness, or standby fee of the district prior to final execution of this contract.

(4) TIDE WATERS: If the Property abuts the tidally influenced waters of the state, Section 33.135, Texas Natural Resources Code, requires a notice regarding coastal area property to be included in the contract.

(5) ANNEXATION: If the Property is located outside the limits of a municipality, Seller notifies Buyer under Section 5.011, Texas Property Code, that the Property may now or later be included in the extraterritorial jurisdiction of a municipality and may now or later be subject to annexation by the municipality. Each municipality maintains a map that depicts its boundaries and extraterritorial jurisdiction. To determine if the Property is located within a municipality's extraterritorial jurisdiction or is likely to be located within a municipality's extraterritorial jurisdiction, contact all municipalities located in the general proximity of the Property for further information.

(6) PROPERTY LOCATED IN A CERTIFICATED SERVICE AREA OF A UTILITY SERVICE PROVIDER: Notice required by Section 13.257, Water Code: The real property, described in Paragraph 2, that you are about to purchase may be located in a certificated water or sewer service area, which is authorized by law to provide water or sewer service to the properties in the certificated area. If your property is located in a certificated area there may be special costs or charges that you will be required to pay before you can receive water or sewer service. There may be a period required to construct lines or other facilities necessary to provide water or sewer service to your property. You are advised to determine if the property is in a certificated area and contact the utility service provider to determine the cost that you will be required to pay and the period, if any, that is required to provide water or sewer service to your property. The undersigned Buyer hereby acknowledges receipt of the foregoing notice at or before the execution of a binding contract for the purchase of the real property described in Paragraph 2 or at closing of purchase of the real property.

(7) PUBLIC IMPROVEMENT DISTRICTS: If the Property is in a public improvement district, Seller must give Buyer written notice as required by Section 5.014, Property Code.

(8) TRANSFER FEES: If the Property is subject to a private transfer fee obligation, Section 5.205, Property Code, requires Seller to notify Buyer as follows: The private transfer fee obligation may be governed by Chapter 5, Subchapter G of the Texas Property Code.

(9) PROPANE GAS SYSTEM SERVICE AREA: If the Property is located in a propane gas system service area owned by a distribution system retailer, Seller must give Buyer written notice as required by Section 141.010, Texas Utilities Code.

(10) NOTICE OF WATER LEVEL FLUCTUATIONS: If the Property adjoins an impoundment of water, including a reservoir or lake, constructed and maintained under Chapter 11, Water Code, that has a storage capacity of at least 5,000 acre-feet at the impoundment's normal operating level, Seller hereby notifies Buyer: "The water level of the impoundment of water adjoining the Property fluctuates for various reasons, including as a result of: (1) an entity lawfully exercising its right to use the water stored in the impoundment; or (2) drought or flood conditions."

(11) CERTIFICATE OF MOLD REMEDIATION: If the Property has been remediated for mold, Seller must provide to Buyer each certificate of mold damage remediation issued under Section 1958.154, Occupations Code, during the 5 years preceding the sale of the Property.

---

### 7. PROPERTY CONDITION

A. ACCESS, INSPECTIONS AND UTILITIES: Seller shall permit Buyer and Buyer's agents access to the Property at reasonable times. Buyer may have the Property inspected by inspectors selected by Buyer and licensed by TREC or otherwise permitted by law to make inspections. Any hydrostatic testing must be separately authorized by Seller in writing. Seller at Seller's expense shall immediately cause existing utilities to be turned on and shall keep the utilities on during the time this contract is in effect.

B. SELLER'S DISCLOSURE NOTICE PURSUANT TO SECTION 5.008, TEXAS PROPERTY CODE: The parties choose: [Trec.SellerDisclosure]

- (1) Buyer has received the Seller's Disclosure Notice.
- (2) Buyer has not received the Seller's Disclosure Notice. Within [Trec.DisclosureDays] days after the Effective Date of this contract, Seller shall deliver the Seller's Disclosure Notice to Buyer. If Buyer does not receive the Seller's Disclosure Notice, Buyer may terminate this contract at any time prior to the closing and the earnest money will be refunded to Buyer. If Seller delivers the Seller's Disclosure Notice, Buyer may terminate this contract for any reason within 7 days after Buyer receives the Seller's Disclosure Notice or prior to the closing, whichever first occurs, and the earnest money will be refunded to Buyer.
- (3) The Seller is not required to furnish the Seller's Disclosure Notice under the Texas Property Code.

C. SELLER'S DISCLOSURE OF LEAD-BASED PAINT AND LEAD-BASED PAINT HAZARDS is required by Federal law for a residential dwelling constructed prior to 1978.

D. ACCEPTANCE OF PROPERTY CONDITION: "As Is" means the present condition of the Property with any and all defects and without warranty except for the warranties of title and the warranties in this contract. Buyer's agreement to accept the Property As Is under Paragraph 7D(1) or (2) does not preclude Buyer from inspecting the Property under Paragraph 7A, from negotiating repairs or treatments in a subsequent amendment, or from terminating this contract during the Option Period, if any. The parties choose: [Trec.AsIs]

- (1) Buyer accepts the Property As Is.
- (2) Buyer accepts the Property As Is provided Seller, at Seller's expense, shall complete the following specific repairs and treatments: [Trec.Repairs] (Do not insert general phrases, such as "subject to inspections" that do not identify specific repairs and treatments.)

E. LENDER REQUIRED REPAIRS AND TREATMENTS: Unless otherwise agreed in writing, neither party is obligated to pay for lender required repairs, which includes treatment for wood destroying insects. If the parties do not agree to pay for the lender required repairs or treatments, this contract will terminate and the earnest money will be refunded to Buyer. If the cost of lender required repairs and treatments exceeds 5% of the Sales Price, Buyer may terminate this contract and the earnest money will be refunded to Buyer.

F. COMPLETION OF REPAIRS AND TREATMENTS: Unless otherwise agreed in writing, Seller shall complete all agreed repairs and treatments prior to the Closing Date and obtain any required permits. The repairs and treatments must be performed by persons who are licensed to provide such repairs or treatments or, if no license is required by law, are commercially engaged in the trade of providing such repairs or treatments. Seller shall: (i) provide Buyer with copies of documentation from the repair person(s) showing the scope of work and payment for the work completed; and (ii) at Seller's expense, arrange for the transfer of any transferable warranties with respect to the repairs and treatments to Buyer at closing. If Seller fails to complete any agreed repairs and treatments prior to the Closing Date, Buyer may exercise remedies under Paragraph 15 or extend the Closing Date up to 5 days if necessary for Seller to complete the repairs and treatments.

G. ENVIRONMENTAL MATTERS: Buyer is advised that the presence of wetlands, toxic substances, including asbestos and wastes or other environmental hazards, or the presence of a threatened or endangered species or its habitat may affect Buyer's intended use of the Property. If Buyer is concerned about these matters, an addendum promulgated by TREC or required by the parties should be used.

H. RESIDENTIAL SERVICE CONTRACTS: Buyer may purchase a residential service contract from a provider or administrator licensed by the Texas Department of Licensing and Regulation. If Buyer purchases a residential service contract, Seller shall reimburse Buyer at closing for the cost of the residential service contract in an amount not exceeding [Trec.ServiceContract]. Buyer should review any residential service contract for the scope of coverage, exclusions and limitations. The purchase of a residential service contract is optional. Similar coverage may be purchased from various companies authorized to do business in Texas.

I. SELLER'S DISCLOSURE ABOUT GROUNDWATER AND SURFACE WATER RIGHTS: Access to surface water or groundwater on the Property may be regulated, restricted, or prohibited, including but not limited to the right to drill or operate water wells and the right to withdraw water from surface water sources on or adjoining the Property. The parties shall use the Seller's Water Disclosure published by TREC to identify information related to groundwater and surface water rights. The parties choose: [Trec.WaterDisclosure]

- (1) Buyer has received the Seller's Water Disclosure.
- (2) Buyer has not received the Seller's Water Disclosure. Within [Trec.WaterDisclosureDays] days after the Effective Date of this contract, Seller shall deliver the Seller's Water Disclosure to Buyer. If Buyer does not receive the Seller's Water Disclosure, Buyer may terminate this contract at any time prior to the closing and the earnest money will be refunded to Buyer. If Seller delivers the Seller's Water Disclosure, Buyer may terminate this contract for any reason within 7 days after Buyer receives the Seller's Water Disclosure or prior to the closing, whichever first occurs, and the earnest money will be refunded to Buyer.
- (3) Seller is not required to deliver the Seller's Water Disclosure to Buyer because all of the following are true: (a) Seller is not aware of a water well on the Property (in use or not in use); (b) Seller is not aware of a pond, lake, or water tank on the Property; (c) Seller is not aware of any certificate of adjudication, certified filing, or permit for surface water rights associated with the Property administered by the Texas Commission on Environmental Quality; (d) Seller is not aware that any groundwater rights to the Property have been severed, sold, or leased in whole or in part; and (e) the Property receives water only from the following municipality (City), municipal utility district (MUD) or other special district, water supply corporation (WSC), or private water supply company (PWC): [Trec.WaterSupplier]

### 8. BROKER OR SALES AGENT DISCLOSURE

Texas law requires a real estate broker or sales agent who is a party to a transaction or acting on behalf of a spouse, parent, child, business entity in which the broker or sales agent owns more than 10%, or a trust for which the broker or sales agent acts as a trustee or of which the broker or sales agent or the broker or sales agent's spouse, parent or child is a beneficiary, to notify the other party in writing before entering into a contract of sale. Disclose if applicable: [Trec.BrokerDisclosure]

### 9. CLOSING

A. The closing of the sale will be on or before [Trec.ClosingDate], or within 7 days after objections made under Paragraph 6D have been cured or waived, whichever date is later (Closing Date). If either party fails to close the sale by the Closing Date, the non-defaulting party may exercise the remedies contained in Paragraph 15.

B. At closing:

- (1) Seller shall execute and deliver a general warranty deed conveying title to the Property to Buyer and showing no additional exceptions to those permitted in Paragraph 6 and furnish tax statements or certificates showing no delinquent taxes on the Property.
- (2) Buyer shall pay the Sales Price in good funds acceptable to the Escrow Agent.
- (3) Seller and Buyer shall execute and deliver any notices, statements, certificates, affidavits, releases, loan documents, transfer of any warranties, and other documents reasonably required for the closing of the sale and the issuance of the Title Policy.
- (4) There will be no liens, assessments, or security interests against the Property which will not be satisfied out of the sales proceeds unless securing the payment of any loans assumed by Buyer and assumed loans will not be in default.
- (5) Private transfer fees (as defined by Chapter 5, Subchapter G of the Texas Property Code) will be the obligation of Seller unless provided otherwise in this contract. Transfer fees assessed by a property owners' association are governed by the Addendum for Property Subject to Mandatory Membership in a Property Owners Association.

### 10. POSSESSION

A. BUYER'S POSSESSION: Seller shall deliver to Buyer possession of the Property in its present or required condition, ordinary wear and tear excepted: [Trec.Possession]. Any possession by Buyer prior to closing or by Seller after closing which is not authorized by a written lease will establish a tenancy at sufferance relationship between the parties. Consult your insurance agent prior to change of ownership and possession because insurance coverage may be limited or terminated. The absence of a written lease or appropriate insurance coverage may expose the parties to economic loss.

B. SMART DEVICES: "Smart Device" means a device that connects to the internet to enable remote use, monitoring, and management of: (i) the Property; (ii) items identified in any Non-Realty Items Addendum; or (iii) items in a Fixture Lease assigned to Buyer. At the time Seller delivers possession of the Property to Buyer, Seller shall: (1) deliver to Buyer written information containing all access codes, usernames, passwords, and applications Buyer will need to access, operate, manage, and control the Smart Devices; and (2) terminate and remove all access and connections to the improvements and accessories from any of Seller's personal devices including but not limited to phones and computers.

### 11. SPECIAL PROVISIONS

(This paragraph is intended to be used only for additional informational items. An informational item is a statement that completes a blank in a contract form, discloses factual information, or provides instructions. Real estate brokers and sales agents are prohibited from practicing law and shall not add to, delete, or modify any provision of this contract unless drafted by a party to this contract or a party's attorney.)

[Trec.SpecialProvisions]

---

### 12. SETTLEMENT AND OTHER EXPENSES

A. EXPENSES: The following expenses must be paid at or prior to closing:

(1) Seller shall pay the following expenses (Seller's Expenses): (a) releases of existing liens, including prepayment penalties and recording fees; release of Seller's loan liability; tax statements or certificates; preparation of deed; one-half of escrow fee; and other expenses payable by Seller under this contract; and (b) an amount not to exceed [Trec.SellerConcession] to be applied to Buyer's Expenses other than brokerage compensation or contributions under Paragraph 12B below.

(2) Buyer shall pay the following expenses (Buyer's Expenses): Appraisal fees; loan application fees; origination charges; credit reports; preparation of loan documents; interest on the notes from date of disbursement to one month prior to dates of first monthly payments; recording fees; copies of easements and restrictions; loan title policy with endorsements required by lender; loan-related inspection fees; photos; amortization schedules; one-half of escrow fee; all prepaid items, including required premiums for flood and hazard insurance, reserve deposits for insurance, ad valorem taxes and special governmental assessments; final compliance inspection; courier fee; repair inspection; underwriting fee; wire transfer fee; expenses incident to any loan; Private Mortgage Insurance Premium (PMI), VA Loan Funding Fee, or FHA Mortgage Insurance Premium (MIP) as required by the lender; and other expenses payable by Buyer under this contract.

B. BROKERAGE COMPENSATION: Brokerage compensation is not set by law and is fully negotiable. Each party shall pay their respective brokers pursuant to the terms of the parties' obligations to compensate their brokers contained in separate written agreements. The contributions under 12B(1) and 12B(2) below shall be applied to and shall not change the parties' obligations to pay compensation pursuant to those agreements. The following contributions must be paid at closing: [Trec.BrokerageContributions]

C. EXPENSE LIMITATION: If a governmental loan program regulation prohibits Buyer from paying charges or fees, then the amount of any concession in 12A(1)(b) shall be first applied to pay such prohibited expenses and then to other Buyer's Expenses but not brokerage compensation or contribution.

### 13. PRORATIONS

Taxes for the current year, interest, rents, and regular periodic maintenance fees, assessments, and dues (including prepaid items) will be prorated through the Closing Date. The tax proration may be calculated taking into consideration any change in exemptions that will affect the current year's taxes. If taxes for the current year vary from the amount prorated at closing, the parties shall adjust the prorations when tax statements for the current year are available. If taxes are not paid at or prior to closing, Buyer shall pay taxes for the current year.

### 14. CASUALTY LOSS

If any part of the Property is damaged or destroyed by fire or other casualty after the Effective Date of this contract, Seller shall restore the Property to its previous condition as soon as reasonably possible, but in any event by the Closing Date. If Seller fails to do so due to factors beyond Seller's control, Buyer may (a) terminate this contract and the earnest money will be refunded to Buyer (b) extend the time for performance up to 15 days and the Closing Date will be extended as necessary or (c) accept the Property in its damaged condition with an assignment of insurance proceeds, if permitted by Seller's insurance carrier, and receive credit from Seller at closing in the amount of the deductible under the insurance policy. Seller's obligations under this paragraph are independent of any other obligations of Seller under this contract.

### 15. DEFAULT

If Buyer fails to comply with this contract, Buyer will be in default, and Seller may (a) enforce specific performance, seek such other relief as may be provided by law, or both, or (b) terminate this contract and receive the earnest money as liquidated damages, thereby releasing both parties from this contract. If Seller fails to comply with this contract, Seller will be in default and Buyer may (a) enforce specific performance, seek such other relief as may be provided by law, or both, or (b) terminate this contract and receive the earnest money, thereby releasing both parties from this contract.

### 16. MEDIATION

It is the policy of the State of Texas to encourage resolution of disputes through alternative dispute resolution procedures such as mediation. Any dispute between Seller and Buyer related to this contract which is not resolved through informal discussion will be submitted to a mutually acceptable mediation service or provider. The parties to the mediation shall bear the mediation costs equally. This paragraph does not preclude a party from seeking equitable relief from a court of competent jurisdiction.

### 17. ATTORNEY'S FEES

A Buyer, Seller, Seller's broker, Buyer's broker, or Escrow Agent who prevails in any legal proceeding related to this contract is entitled to recover reasonable attorney's fees and all costs of such proceeding.

### 18. ESCROW

A. ESCROW: The Escrow Agent is not (i) a party to this contract and does not have liability for the performance or nonperformance of any party to this contract, (ii) liable for interest on the earnest money and (iii) liable for the loss of any earnest money caused by the failure of any financial institution in which the earnest money has been deposited unless the financial institution is acting as Escrow Agent. Escrow Agent may require any disbursement made in connection with this contract to be conditioned on Escrow Agent's collection of good funds acceptable to Escrow Agent.

B. EXPENSES: At closing, the earnest money must be applied first to any cash down payment, then to Buyer's Expenses and any excess refunded to Buyer. If no closing occurs, Escrow Agent may: (i) require a written release of liability of the Escrow Agent from all parties before releasing any earnest money; and (ii) require payment of unpaid expenses incurred on behalf of a party. Escrow Agent may deduct authorized expenses from the earnest money payable to a party. "Authorized expenses" means expenses incurred by Escrow Agent on behalf of the party entitled to the earnest money that were authorized by this contract or that party.

C. DEMAND: Upon termination of this contract, either party or the Escrow Agent may send a release of earnest money to each party and the parties shall execute counterparts of the release and deliver same to the Escrow Agent. If either party fails to execute the release, either party may make a written demand to the Escrow Agent for the earnest money. If only one party makes written demand for the earnest money, Escrow Agent shall promptly provide a copy of the demand to the other party. If Escrow Agent does not receive written objection to the demand from the other party within 15 days, Escrow Agent may disburse the earnest money to the party making demand reduced by the amount of unpaid expenses incurred on behalf of the party receiving the earnest money and Escrow Agent may pay the same to the creditors. If Escrow Agent complies with the provisions of this paragraph, each party hereby releases Escrow Agent from all adverse claims related to the disbursal of the earnest money.

D. DAMAGES: Any party who wrongfully fails or refuses to sign a release acceptable to the Escrow Agent within 7 days of receipt of the request will be liable to the other party for (i) damages; (ii) the earnest money; (iii) reasonable attorney's fees; and (iv) all costs of suit.

E. NOTICES: Escrow Agent's notices will be effective when sent in compliance with Paragraph 21. Notice of objection to the demand will be deemed effective upon receipt by Escrow Agent.

### 19. REPRESENTATIONS

All covenants, representations and warranties in this contract survive closing. If any representation of Seller in this contract is untrue on the Closing Date, Seller will be in default. Unless expressly prohibited by written agreement, Seller may continue to show the Property and receive, negotiate and accept back up offers.

### 20. GOVERNMENTAL REQUIREMENTS

A. If Seller is a "foreign person," as defined by Internal Revenue Code and its regulations, or if Seller fails to deliver an affidavit or a certificate of non-foreign status to Buyer that Seller is not a "foreign person," then Buyer shall withhold from the sales proceeds an amount sufficient to comply with applicable tax law and deliver the same to the Internal Revenue Service together with appropriate tax forms. Internal Revenue Service regulations require filing written reports if currency in excess of specified amounts is received in the transaction.

B. Seller and Buyer shall promptly execute and deliver any statements, documents, and information requested by Escrow Agent required by governmental reporting requirements (for example, reporting to the U.S. Treasury or its bureaus).

### 21. NOTICES

All notices from one party or their agent to the other must be in writing. Notices are effective when mailed to, hand-delivered at, sent by overnight courier to, or transmitted by electronic transmission to the other party or their agent.

To Buyer at: [Company.Address] · Phone: [Company.Phone] · Email: [Company.Email]

To Seller at: [Property.FullAddress] · Phone: [Seller.Phone] · Email: [Seller.Email]

To Buyer's agent at: [Trec.BuyerAgent]

To Seller's agent at: [Trec.SellerAgent]

### 22. AGREEMENT OF PARTIES

This contract contains the entire agreement of the parties and cannot be changed except by their written agreement. Addenda and notices which are a part of this contract are: [Trec.Addenda]

NOTICE: Seller's failure to provide applicable Statutory Disclosures and Notices may provide Buyer with remedies or rights to terminate this contract.

### 23. CONSULT AN ATTORNEY BEFORE SIGNING

TREC rules prohibit real estate brokers and sales agents from giving legal advice. READ THIS CONTRACT CAREFULLY.

Buyer's attorney is: [Trec.BuyerAttorney]

Seller's attorney is: [Trec.SellerAttorney]

---

# EXECUTED

EXECUTED on [Date.Today] (Effective Date). The broker fills in the date of final acceptance.

{{sign:seller}}

{{sign:seller2}}

{{sign:buyer}}

###### The form of this contract has been approved by the Texas Real Estate Commission. TREC forms are intended for use only by trained real estate license holders. No representation is made as to the legal validity or adequacy of any provision in any specific transactions. It is not intended for complex transactions. Texas Real Estate Commission, P.O. Box 12188, Austin, TX 78711-2188, (512) 936-3000 (http://www.trec.texas.gov) TREC NO. 20-19. This form replaces TREC NO. 20-18.

### BROKER CONTACT INFORMATION

(Print names only. Do not sign.)

Broker representing Seller: [Trec.SellerBroker]

Broker representing Buyer: [Trec.BuyerBroker]

Intermediary: [Trec.Intermediary]
$body$)
on conflict (coalesce(workspace_id, 0), key) do update
  set name = excluded.name, kind = excluded.kind, sort = excluded.sort,
      signers = excluded.signers, body_md = excluded.body_md, active = true;

-- ------------------------------------------------------ the engine's default
-- A contract row now comes from the built-in engine unless something
-- explicitly says PandaDoc, so the column default follows.
alter table public.contracts alter column provider set default 'clozr';

-- Workspaces that were flipped to the PandaDoc packet go back to the engine
-- that fills the template and mints a signing link. A workspace that really
-- does drive PandaDoc through the API (it has a template id on file) is left
-- alone.
update public.workspaces
   set settings = jsonb_set(settings, '{offers,engine}', '"clozr"', true)
 where settings ? 'offers'
   and coalesce(settings #>> '{offers,engine}', '') <> 'clozr'
   and coalesce(settings #>> '{offers,pandadoc_template_id}', '') = '';
