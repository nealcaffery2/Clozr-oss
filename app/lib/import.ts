// Bulk import: a spreadsheet in, leads out.
//
// Three stages, each pure until the last:
//   parseTable   — CSV, TSV or a paste from a spreadsheet → headers + rows.
//   autoMap      — guess which CLOZR field each column is, from the header
//                  and from what the values look like. Knows the export shapes
//                  of Podio, PropStream, DealMachine, InvestorLift, BatchLeads
//                  and REISift by their column names, and falls back to fuzzy
//                  matching for anything else.
//   importRows   — write the mapped rows through the same find-or-create the
//                  ingest door uses, so an imported address and the same
//                  address arriving later from Deal Machine land on one record.
//
// The person doing the import always sees and can correct the mapping before
// anything is written. The matcher is there to make that a glance, not a
// chore.

import { attachPhotoLinks, parseLinks } from './deal-files';
import { type Json } from './database.types';
import { type Table, parseTable } from './parse-table';
import { supabase } from './supabase';

export { type Table, parseTable };
import { buyerRow, eachLimited, enrollInPlan, enrollSellersInPlan, moveOpenDeals, parseDue } from './crm-write';
import { type Action, type DealOnFile, type Existing, type Keys, type Match, classify, mergePatch, planImportDeal } from './import-dedupe';
import { toE164 } from './talkr';
import { type FoundPhone, keepImportPhones } from './seller-phones';
import { type PropertyFacts, SELLER_IMPORT_COLUMNS, importBlock, isMissingColumn, withoutImportColumns } from './import-extras';
import { normalizeMarkets, normalizePlace } from './place-names';
import { logRun, notifyUser } from './data-runs';
import { parseDollarRange } from './money';
import { CHANNEL_MAP, DG_CHIPS, FUNDING_MAP, RESTRICTION_MAP, STRATEGY_MAP, TYPE_MAP, buyerTypeCode, codeOf, normalizeBuyBox } from './buyer-profile';

// ---- targets ----------------------------------------------------------------

/**
 * What a column can be mapped to. `extra` keeps the column as it is, under its
 * header (sellers.import_extra, or the notes): what every column the matcher
 * has no field for becomes, so nothing in a file is dropped unless a person
 * picks `skip`.
 */
export type Target =
  | 'skip' | 'extra'
  | 'name' | 'first_name' | 'last_name' | 'phone' | 'phone2' | 'phone_type' | 'phone_dnc' | 'email'
  | 'owner2_name' | 'owner2_first' | 'owner2_last'
  | 'mail_addr' | 'mail_unit' | 'mail_city' | 'mail_st' | 'mail_zip' | 'do_not_mail'
  | 'addr' | 'unit' | 'city' | 'st' | 'zip' | 'county' | 'full_address'
  | 'asking' | 'arv' | 'rehab' | 'offer'
  | 'motivation' | 'notes' | 'source' | 'stage' | 'tags'
  | 'beds' | 'baths' | 'sqft' | 'lot_sqft' | 'year' | 'apn'
  | 'est_value' | 'assessed_value' | 'est_equity' | 'ltv' | 'open_loans' | 'loan_balance' | 'lien_amount' | 'monthly_rent'
  | 'last_sale_date' | 'last_sale_price' | 'mls_status' | 'mls_date' | 'mls_amount' | 'vacant' | 'absentee' | 'owner_occupied'
  | 'created' | 'photos'
  // What a partner's submission sheet says (properties.facts), and who sent the row.
  | 'market' | 'garage' | 'occupancy' | 'listed_mls' | 'on_investorlift' | 'portfolio' | 'submitter'
  // Buyers and vendors.
  | 'company' | 'markets' | 'buyer_type' | 'entity_type' | 'min_price' | 'max_price'
  | 'buy_box' | 'website' | 'preferred_channel' | 'vip' | 'contact_name' | 'service_type'
  | 'source_id'
  | 'strategy' | 'property_type' | 'min_beds' | 'min_baths'
  | 'min_sqft' | 'max_sqft' | 'min_year' | 'max_year' | 'min_lot' | 'max_lot'
  | 'funding' | 'timeline' | 'restrictions' | 'requirements'
  | 'vetted' | 'blacklisted' | 'wants_calls' | 'wants_follow_ups';

/** Which table an import writes to. */
export type RecordKind = 'sellers' | 'buyers' | 'vendors';

/** The two choices for a column with no field: keep it as extra info (the default), or leave it out on purpose. */
const KEEP: { key: Target; label: string; group: string }[] = [
  { key: 'extra', label: 'Keep as extra info', group: '' },
  { key: 'skip', label: 'Don’t import this column', group: '' },
];

export const TARGETS: { key: Target; label: string; group: string }[] = [
  ...KEEP,
  { key: 'name', label: 'Seller name', group: 'Seller' },
  { key: 'first_name', label: 'First name', group: 'Seller' },
  { key: 'last_name', label: 'Last name', group: 'Seller' },
  { key: 'phone', label: 'Phone (the first is the main number)', group: 'Seller' },
  { key: 'phone2', label: 'Another phone', group: 'Seller' },
  { key: 'phone_type', label: 'Phone type (mobile, landline…)', group: 'Seller' },
  { key: 'phone_dnc', label: 'Phone DNC / litigator flag', group: 'Seller' },
  { key: 'email', label: 'Email (the first is the main one)', group: 'Seller' },
  { key: 'owner2_name', label: 'Owner 2 name', group: 'Owner 2' },
  { key: 'owner2_first', label: 'Owner 2 first name', group: 'Owner 2' },
  { key: 'owner2_last', label: 'Owner 2 last name', group: 'Owner 2' },
  { key: 'mail_addr', label: 'Mailing address', group: 'Mailing address' },
  { key: 'mail_unit', label: 'Mailing unit', group: 'Mailing address' },
  { key: 'mail_city', label: 'Mailing city', group: 'Mailing address' },
  { key: 'mail_st', label: 'Mailing state', group: 'Mailing address' },
  { key: 'mail_zip', label: 'Mailing ZIP', group: 'Mailing address' },
  { key: 'do_not_mail', label: 'Do not mail (yes/no)', group: 'Mailing address' },
  { key: 'full_address', label: 'Full address (one column)', group: 'Property' },
  { key: 'addr', label: 'Street address', group: 'Property' },
  { key: 'unit', label: 'Unit #', group: 'Property' },
  { key: 'city', label: 'City', group: 'Property' },
  { key: 'st', label: 'State', group: 'Property' },
  { key: 'zip', label: 'ZIP', group: 'Property' },
  { key: 'county', label: 'County', group: 'Property' },
  { key: 'property_type', label: 'Property type', group: 'Property' },
  { key: 'beds', label: 'Beds', group: 'Property' },
  { key: 'baths', label: 'Baths', group: 'Property' },
  { key: 'sqft', label: 'Sqft', group: 'Property' },
  { key: 'lot_sqft', label: 'Lot size (sqft, or acres)', group: 'Property' },
  { key: 'year', label: 'Year built', group: 'Property' },
  { key: 'apn', label: 'APN', group: 'Property' },
  { key: 'photos', label: 'Photo links (Drive / Dropbox folder or images)', group: 'Property' },
  { key: 'garage', label: 'Garage', group: 'Property' },
  { key: 'market', label: 'Market (metro)', group: 'Property' },
  { key: 'est_value', label: 'Est. value (AVM)', group: 'Value & loans' },
  { key: 'assessed_value', label: 'Assessed value', group: 'Value & loans' },
  { key: 'est_equity', label: 'Est. equity', group: 'Value & loans' },
  { key: 'ltv', label: 'Est. loan-to-value %', group: 'Value & loans' },
  { key: 'open_loans', label: 'Open loans', group: 'Value & loans' },
  { key: 'loan_balance', label: 'Loan balance', group: 'Value & loans' },
  { key: 'lien_amount', label: 'Lien amount', group: 'Value & loans' },
  { key: 'monthly_rent', label: 'Monthly rent', group: 'Value & loans' },
  { key: 'last_sale_date', label: 'Last sale date', group: 'Value & loans' },
  { key: 'last_sale_price', label: 'Last sale amount', group: 'Value & loans' },
  { key: 'vacant', label: 'Vacant', group: 'Status' },
  { key: 'absentee', label: 'Absentee owner', group: 'Status' },
  { key: 'owner_occupied', label: 'Owner occupied', group: 'Status' },
  { key: 'occupancy', label: 'Occupied (yes/no, tenant…)', group: 'Status' },
  { key: 'listed_mls', label: 'Listed on MLS (yes/no)', group: 'Status' },
  { key: 'on_investorlift', label: 'On InvestorLift (yes/no)', group: 'Status' },
  { key: 'portfolio', label: 'One property or portfolio', group: 'Status' },
  { key: 'mls_status', label: 'MLS status', group: 'Status' },
  { key: 'mls_date', label: 'MLS date', group: 'Status' },
  { key: 'mls_amount', label: 'MLS amount', group: 'Status' },
  { key: 'asking', label: 'Asking price', group: 'Deal' },
  { key: 'arv', label: 'ARV', group: 'Deal' },
  { key: 'rehab', label: 'Rehab estimate', group: 'Deal' },
  { key: 'offer', label: 'Offer / contract price', group: 'Deal' },
  { key: 'stage', label: 'Stage', group: 'Deal' },
  { key: 'motivation', label: 'Motivation', group: 'Lead' },
  { key: 'source', label: 'Lead source', group: 'Lead' },
  { key: 'submitter', label: 'Submitted by (partner company)', group: 'Lead' },
  { key: 'tags', label: 'Tags', group: 'Lead' },
  { key: 'notes', label: 'Notes', group: 'Lead' },
  { key: 'created', label: 'Created date', group: 'Lead' },
  { key: 'source_id', label: 'Record ID (re-import updates it)', group: 'Lead' },
];

export const BUYER_TARGETS: typeof TARGETS = [
  ...KEEP,
  { key: 'name', label: 'Buyer name', group: 'Buyer' },
  { key: 'first_name', label: 'First name', group: 'Buyer' },
  { key: 'last_name', label: 'Last name', group: 'Buyer' },
  { key: 'company', label: 'Company / LLC', group: 'Buyer' },
  { key: 'phone', label: 'Phone (the first is the main number)', group: 'Buyer' },
  { key: 'phone2', label: 'Another phone', group: 'Buyer' },
  { key: 'email', label: 'Email (the first is the main one)', group: 'Buyer' },
  { key: 'website', label: 'Website', group: 'Buyer' },
  { key: 'buyer_type', label: 'Buyer type', group: 'Profile' },
  { key: 'entity_type', label: 'Entity type', group: 'Profile' },
  { key: 'preferred_channel', label: 'Preferred channel', group: 'Profile' },
  { key: 'vip', label: 'VIP (yes/no)', group: 'Profile' },
  { key: 'vetted', label: 'Vetted (yes/no)', group: 'Profile' },
  { key: 'blacklisted', label: 'Blacklisted (yes/no)', group: 'Profile' },
  { key: 'wants_calls', label: 'Wants calls / DND', group: 'Profile' },
  { key: 'wants_follow_ups', label: 'Wants follow-ups', group: 'Profile' },
  { key: 'markets', label: 'Markets / buy areas', group: 'Buy box' },
  { key: 'min_price', label: 'Min purchase price', group: 'Buy box' },
  { key: 'max_price', label: 'Max purchase price', group: 'Buy box' },
  { key: 'strategy', label: 'Strategy (fix & flip, buy & hold…)', group: 'Buy box' },
  { key: 'property_type', label: 'Property type', group: 'Buy box' },
  { key: 'min_beds', label: 'Min bedrooms', group: 'Buy box' },
  { key: 'min_baths', label: 'Min bathrooms', group: 'Buy box' },
  { key: 'min_sqft', label: 'Min sqft', group: 'Buy box' },
  { key: 'max_sqft', label: 'Max sqft', group: 'Buy box' },
  { key: 'min_year', label: 'Min year built', group: 'Buy box' },
  { key: 'max_year', label: 'Max year built', group: 'Buy box' },
  { key: 'min_lot', label: 'Min lot sqft', group: 'Buy box' },
  { key: 'max_lot', label: 'Max lot sqft', group: 'Buy box' },
  { key: 'funding', label: 'Funding (cash, hard money…)', group: 'Buy box' },
  { key: 'timeline', label: 'Timeline to close (days)', group: 'Buy box' },
  { key: 'restrictions', label: 'Restrictions (won’t buy)', group: 'Buy box' },
  { key: 'requirements', label: 'Requirements (must have)', group: 'Buy box' },
  { key: 'buy_box', label: 'Buy box / criteria (text)', group: 'Buy box' },
  { key: 'tags', label: 'Tags', group: 'Other' },
  { key: 'notes', label: 'Notes', group: 'Other' },
  { key: 'source_id', label: 'Record ID (re-import updates it)', group: 'Other' },
];

export const VENDOR_TARGETS: typeof TARGETS = [
  ...KEEP,
  { key: 'name', label: 'Business name', group: 'Vendor' },
  { key: 'contact_name', label: 'Contact name', group: 'Vendor' },
  { key: 'phone', label: 'Phone', group: 'Vendor' },
  { key: 'email', label: 'Email', group: 'Vendor' },
  { key: 'service_type', label: 'Service type', group: 'Vendor' },
  { key: 'markets', label: 'Markets / service area', group: 'Vendor' },
  { key: 'notes', label: 'Notes', group: 'Vendor' },
];

export const TARGETS_BY_KIND: Record<RecordKind, typeof TARGETS> = { sellers: TARGETS, buyers: BUYER_TARGETS, vendors: VENDOR_TARGETS };

type Aliases = Partial<Record<Exclude<Target, 'skip'>, string[]>>;

/**
 * Header aliases, normalised (lowercase, letters and digits only). The first
 * list per target is what the common exports call the column; the matcher
 * also tries token overlap so "Owner Mailing Phone 1" still lands on phone.
 */
const ALIASES: Aliases = {
  name: ['name', 'sellername', 'seller', 'ownername', 'owner', 'contact', 'contactname', 'fullname', 'lead', 'leadname', 'relatedcontact', 'propertyowner', 'owner1', 'owner1name', 'owner1fullname', 'primaryowner'],
  first_name: ['firstname', 'first', 'ownerfirstname', 'owner1firstname', 'sellerfirstname', 'fname', 'owner1first'],
  last_name: ['lastname', 'last', 'ownerlastname', 'owner1lastname', 'sellerlastname', 'lname', 'surname', 'owner1last'],
  // Podio writes a phone or email field with its kind after a dash: "Phone - Mobile", "Email - Work".
  phone: ['phone', 'phonenumber', 'mobile', 'cell', 'cellphone', 'sellerphone', 'ownerphone', 'phone1', 'primaryphone', 'mobilephone', 'telephone', 'tel', 'contactphone', 'number', 'wireless', 'primaryphonenumber', 'phonemobile', 'phonemain', 'phonecell'],
  phone2: ['phone2', 'secondphone', 'altphone', 'alternatephone', 'otherphone', 'landline', 'homephone', 'workphone', 'otherphones', 'additionalphones', 'additionalphone', 'phonework', 'phonehome', 'phoneother'],
  phone_type: ['phonetype', 'linetype', 'phonelinetype', 'numbertype', 'phonekind'],
  phone_dnc: ['dnc', 'phonednc', 'donotcall', 'litigator', 'phonelitigator', 'isdnc', 'dncstatus', 'dncflag', 'tcpa', 'tcpalitigator', 'knownlitigator'],
  email: ['email', 'emailaddress', 'selleremail', 'owneremail', 'contactemail', 'email1', 'mail', 'primaryemail', 'emails', 'emailaddresses', 'emailwork', 'emailhome', 'emailother', 'emailpersonal', 'emailmain'],
  owner2_name: ['owner2', 'owner2name', 'owner2fullname', 'coowner', 'coownername', 'secondowner', 'secondownername', 'spouse', 'spousename'],
  owner2_first: ['owner2firstname', 'owner2first', 'coownerfirstname', 'secondownerfirstname'],
  owner2_last: ['owner2lastname', 'owner2last', 'coownerlastname', 'secondownerlastname'],
  mail_addr: ['mailingaddress', 'mailaddress', 'mailingstreet', 'mailingaddress1', 'mailingaddressline1', 'mailstreet', 'owneraddress', 'ownermailingaddress', 'mailingstreetaddress', 'mailaddress1', 'mailingfulladdress', 'mailingline1', 'mailaddressline1'],
  mail_unit: ['mailingunit', 'mailingunitnumber', 'mailunit', 'mailingaddress2', 'mailingaddressline2', 'mailingapt', 'mailaddress2', 'mailingline2'],
  mail_city: ['mailingcity', 'mailcity', 'ownercity', 'ownermailingcity'],
  mail_st: ['mailingstate', 'mailstate', 'ownerstate', 'ownermailingstate'],
  mail_zip: ['mailingzip', 'mailzip', 'mailingzipcode', 'mailzipcode', 'ownerzip', 'ownermailingzip', 'mailingzip5', 'mailingpostalcode'],
  do_not_mail: ['donotmail', 'dnm', 'nomail', 'mailingdonotmail'],
  full_address: ['address', 'propertyaddress', 'fulladdress', 'situsaddress', 'situs', 'property', 'location', 'propertyfulladdress', 'streetaddress'],
  addr: ['street', 'addressline1', 'address1', 'line1', 'propertystreet', 'situsstreet', 'streetaddress1', 'propertyaddressline1', 'addr'],
  unit: ['unit', 'unitnumber', 'unitno', 'apt', 'aptnumber', 'apartment', 'suite', 'propertyunit', 'propertyunitnumber', 'addressline2', 'address2', 'line2', 'propertyaddressline2'],
  city: ['city', 'propertycity', 'situscity', 'town', 'addresscity'],
  st: ['state', 'st', 'propertystate', 'situsstate', 'addressstate', 'province'],
  zip: ['zip', 'zipcode', 'postalcode', 'postal', 'propertyzip', 'situszip', 'zip5', 'addresszip', 'propertyzipcode'],
  county: ['county', 'propertycounty', 'countyname', 'situscounty'],
  property_type: ['propertytype', 'proptype', 'landuse', 'propertyuse', 'propertyusegroup', 'propertyclass', 'usetype', 'propertysubtype'],
  beds: ['beds', 'bedrooms', 'bed', 'br', 'bd', 'totalbedrooms', 'bedroomcount'],
  baths: ['baths', 'bathrooms', 'bath', 'ba', 'totalbathrooms', 'totalbaths', 'bathroomcount'],
  sqft: ['sqft', 'squarefeet', 'squarefootage', 'sf', 'livingarea', 'buildingsqft', 'gla', 'size', 'livingsqft', 'livingsquarefeet', 'buildingarea', 'totalbuildingsqft', 'heatedsqft', 'buildingsquarefeet'],
  lot_sqft: ['lotsize', 'lotsizesqft', 'lotsqft', 'lotsquarefeet', 'lotarea', 'lotsizesquarefeet', 'lotsizeacres', 'lotacres', 'acres', 'acreage'],
  year: ['yearbuilt', 'year', 'built', 'yr', 'yrbuilt', 'effectiveyearbuilt', 'effectiveyear', 'yearbuild'],
  apn: ['apn', 'parcel', 'parcelnumber', 'parcelid', 'pin', 'taxid', 'folio', 'apnnumber', 'parcelno'],
  est_value: ['estvalue', 'estimatedvalue', 'avm', 'value', 'marketvalue', 'estimatedmarketvalue', 'propertyvalue', 'currentvalue', 'estmarketvalue'],
  assessed_value: ['totalassessedvalue', 'assessedvalue', 'assessedtotalvalue', 'taxassessedvalue', 'assessment', 'totalassessment'],
  est_equity: ['estequity', 'estimatedequity', 'equity', 'equityamount', 'availableequity', 'estequityamount'],
  ltv: ['estloantovalue', 'loantovalue', 'ltv', 'estltv', 'estimatedloantovalue', 'currentltv', 'combinedltv'],
  open_loans: ['totalopenloans', 'openloans', 'numberofopenloans', 'openloancount', 'openmortgages', 'totalloans', 'numberofloans'],
  loan_balance: ['estremainingbalanceofopenloans', 'remainingbalance', 'loanbalance', 'mortgagebalance', 'openmortgagebalance', 'totalloanbalance', 'estimatedmortgagebalance', 'estremainingbalance', 'totalopenloanbalance', 'estloanbalance', 'estimatedremainingbalance'],
  lien_amount: ['lienamount', 'totallienamount', 'liens', 'lienbalance', 'totalliens'],
  monthly_rent: ['monthlyrent', 'estmonthlyrent', 'rent', 'rentestimate', 'estimatedrent', 'marketrent', 'rentamount', 'estimatedmonthlyrent'],
  last_sale_date: ['lastsalerecordingdate', 'lastsaledate', 'saledate', 'lastsolddate', 'lastsalesdate', 'recordingdate', 'solddate', 'lastsalecontractdate'],
  last_sale_price: ['lastsaleamount', 'lastsaleprice', 'saleprice', 'lastsoldprice', 'saleamount', 'lastsalesprice', 'soldprice'],
  mls_status: ['mlsstatus', 'listingstatus', 'mlslistingstatus'],
  mls_date: ['mlsdate', 'mlslistingdate', 'listingdate', 'mlsstatusdate', 'mlslisteddate'],
  mls_amount: ['mlsamount', 'mlsprice', 'mlslistingamount', 'mlslistprice', 'mlslistingprice'],
  vacant: ['vacant', 'isvacant', 'vacancy', 'vacantflag', 'propertyvacant'],
  absentee: ['absentee', 'absenteeowner', 'isabsentee', 'absenteeownerflag'],
  owner_occupied: ['owneroccupied', 'isowneroccupied', 'owneroccupancy'],
  asking: ['asking', 'askingprice', 'price', 'listprice', 'sellerasking', 'wants', 'askprice', 'whatpriceareyouasking', 'whatareyouasking', 'yourprice'],
  arv: ['arv', 'afterrepairvalue', 'estimatedarv', 'arvinyouropinion'],
  rehab: ['rehab', 'rehabestimate', 'repairs', 'repaircost', 'rehabcost', 'estimatedrepairs', 'rehabinyouropinion', 'repairsinyouropinion'],
  offer: ['offer', 'offerprice', 'contractprice', 'undercontractprice', 'purchaseprice', 'mao', 'ouroffer'],
  stage: ['stage', 'status', 'leadstatus', 'pipelinestage', 'dealstage', 'category'],
  motivation: ['motivation', 'reason', 'whyselling', 'reasonforselling', 'sellermotivation', 'situation', 'reasonforsellingifyouhaveit'],
  source: ['source', 'leadsource', 'campaign', 'channel', 'list', 'listname', 'origin', 'marketingsource'],
  tags: ['tags', 'tag', 'labels', 'lists', 'marketinglists', 'marketinglist', 'listnames'],
  notes: ['notes', 'note', 'comments', 'comment', 'description', 'remarks', 'details', 'memo'],
  created: ['created', 'createdat', 'createddate', 'date', 'dateadded', 'added', 'leaddate', 'createdon', 'timestamp', 'dateaddedtolist', 'dateaddedtolists'],
  source_id: ['id', 'recordid', 'itemid', 'leadid', 'externalid', 'podioid', 'uniqueid', 'sellerid'],
  photos: ['photos', 'photo', 'photolinks', 'photolink', 'photourl', 'photourls', 'pictures', 'picturelinks', 'images', 'imagelinks', 'media', 'photofolder',
    'photosfolder', 'photoslink', 'photosurl', 'picturefolder', 'picturesfolder', 'mediafolder', 'medialink', 'drivelink', 'drivefolder', 'dropbox', 'dropboxlink'],
  market: ['market', 'metro', 'msa', 'metroarea', 'marketarea', 'marketname'],
  garage: ['garage', 'garageinfo', 'garagetype', 'garagespaces', 'garagesize', 'parking', 'parkingtype'],
  occupancy: ['occupied', 'occupancy', 'occupancystatus', 'isoccupied', 'occupiedvacant', 'tenantoccupied', 'currentlyoccupied'],
  listed_mls: ['listedonmls', 'onmls', 'mlslisted', 'islisted', 'listed', 'currentlylisted', 'onthemls'],
  on_investorlift: ['haveyouputthepropertyoninvestorlift', 'oninvestorlift', 'investorlift', 'listedoninvestorlift'],
  portfolio: ['onepropertyorportfolio', 'propertyorportfolio', 'portfolio', 'isportfolio', 'singleorportfolio'],
  submitter: ['entityname', 'vendorentityname', 'vendorentity', 'entityvendor', 'submittingentity', 'partnerentity', 'partnerentityname', 'submittedby', 'submitter', 'submittercompany', 'partner', 'partnername', 'partnercompany', 'wholesaler', 'wholesalername', 'wholesalercompany', 'vendor', 'vendorname'],
};

const BUYER_ALIASES: Aliases = {
  name: ['name', 'buyername', 'buyer', 'investor', 'investorname', 'contact', 'contactname', 'fullname', 'cashbuyer'],
  first_name: ['firstname', 'first', 'fname', 'buyerfirstname'],
  last_name: ['lastname', 'last', 'lname', 'surname', 'buyerlastname'],
  company: ['company', 'companyname', 'business', 'businessname', 'llc', 'entity', 'entityname', 'organization', 'org', 'firm'],
  phone: ALIASES.phone,
  phone2: ALIASES.phone2,
  email: ALIASES.email,
  website: ['website', 'url', 'site', 'web', 'webpage'],
  buyer_type: ['buyertype', 'investortype'],
  entity_type: ['entitytype', 'ownershiptype'],
  preferred_channel: ['preferredchannel', 'contactpreference', 'preferredcontact', 'channel', 'contactmethod', 'notificationmethod'],
  vip: ['vip', 'isvip', 'priority', 'vipbuyer'],
  vetted: ['vetted', 'isvetted', 'vettedbuyer', 'vettedat'],
  blacklisted: ['blacklisted', 'blacklist', 'isblacklist', 'dnc'],
  wants_calls: ['wantscalls', 'dnd', 'donotdisturb', 'donotcall', 'calls'],
  wants_follow_ups: ['wantsfollowups', 'nofollowups', 'allowfollowups', 'followups'],
  markets: ['markets', 'market', 'areas', 'buyareas', 'buyingareas', 'targetareas', 'targetmarkets', 'locations', 'cities', 'counties', 'zips', 'zipcodes', 'region'],
  min_price: ['minprice', 'minpurchaseprice', 'pricemin', 'minimumprice', 'minbudget'],
  max_price: ['maxprice', 'maxpurchaseprice', 'pricemax', 'maximumprice', 'maxbudget', 'budget', 'pricerange'],
  strategy: ['strategy', 'strategies', 'exitstrategy', 'investmentstrategy'],
  property_type: ['propertytype', 'propertytypes', 'desiredpropertytype', 'assettype'],
  min_beds: ['minbeds', 'minbedrooms', 'minbedroom', 'bedsmin', 'bedrooms'],
  min_baths: ['minbaths', 'minbathrooms', 'minbathroom', 'bathsmin', 'bathrooms'],
  min_sqft: ['minsqft', 'minsquarefeet', 'minsqfootage'],
  max_sqft: ['maxsqft', 'maxsquarefeet', 'maxsqfootage'],
  min_year: ['minyear', 'minyearbuild', 'minyearbuilt', 'yearmin'],
  max_year: ['maxyear', 'maxyearbuild', 'maxyearbuilt', 'yearmax'],
  min_lot: ['minlot', 'minlotsize', 'minlotsqft'],
  max_lot: ['maxlot', 'maxlotsize', 'maxlotsqft'],
  funding: ['funding', 'financetype', 'financing', 'funds'],
  timeline: ['timeline', 'timelinetoclose', 'closedays', 'daystoclose'],
  restrictions: ['restrictions', 'locationrestrictions', 'buyingrestrictions'],
  requirements: ['requirements', 'musthave', 'musthaves'],
  buy_box: ['buybox', 'criteria', 'buycriteria', 'buyingcriteria', 'lookingfor', 'wants'],
  tags: ALIASES.tags,
  notes: ['notes', 'note', 'comments', 'comment', 'description', 'remarks', 'details', 'memo'],
  source_id: ['id', 'recordid', 'itemid', 'buyerid', 'externalid', 'podioid', 'uniqueid', 'customerid'],
};

const VENDOR_ALIASES: Aliases = {
  name: ['businessname', 'business', 'company', 'companyname', 'vendor', 'vendorname', 'name', 'organization'],
  contact_name: ['contact', 'contactname', 'contactperson', 'person', 'rep', 'fullname', 'owner'],
  phone: ALIASES.phone,
  email: ALIASES.email,
  service_type: ['servicetype', 'service', 'services', 'type', 'category', 'trade', 'kind', 'specialty', 'vendortype'],
  markets: ['markets', 'market', 'area', 'servicearea', 'serviceareas', 'city', 'cities', 'counties', 'region'],
  notes: ALIASES.notes,
};

const ALIASES_BY_KIND: Record<RecordKind, Aliases> = { sellers: ALIASES, buyers: BUYER_ALIASES, vendors: VENDOR_ALIASES };

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
/** A Podio header without its field-part suffix (" - amount", " - start") or a note in brackets. */
const podioLabel = (h: string) => h.replace(/\s+-\s*(amount|start|end|value|text)\s*$/i, '').replace(/\s*\([^)]*\)/g, '').trim() || h;
const tokens = (h: string) => h.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

// ---- mapping ----------------------------------------------------------------

export type Mapping = Record<number, Target>;
/** How sure the mapping is about a column: an exact header, a partial header or value match, or nothing. */
export type Confidence = 'high' | 'medium' | 'low';
export type Confidences = Record<number, Confidence>;

const looksLikePhone = (v: string) => /(?:\d[\s().-]*){10,}/.test(v);
const looksLikeEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
const looksLikeZip = (v: string) => /^\d{5}(-\d{4})?$/.test(v);
const looksLikeState = (v: string) => /^[A-Z]{2}$/.test(v);
const looksLikeMoney = (v: string) => /^\$?\s?\d{1,3}(,\d{3})+(\.\d+)?$|^\$\s?\d+/.test(v);
const looksLikeAddress = (v: string) => /^\d+\s+\S+.*\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|way|pl|trail|trl|cir|circle|pkwy|hwy)\b/i.test(v);

/** Targets more than one column can carry: every phone and email is kept, extra columns, the list-ish fields. */
const MULTI_TARGETS = new Set<Target>(['extra', 'phone', 'phone_type', 'phone_dnc', 'email', 'restrictions', 'requirements', 'tags', 'notes', 'markets']);
export const isMultiTarget = (t: Target) => t === 'skip' || MULTI_TARGETS.has(t);

/**
 * Targets matched on an exact header only, never on shared words: "Market" is
 * not "Market Value", "Contract Date" is not "Last Sale Contract Date". A
 * column the exact names miss is kept as extra info for a person to map.
 */
const EXACT_ONLY = new Set<Target>([
  'phone_type', 'phone_dnc', 'owner2_name', 'owner2_first', 'owner2_last',
  'mail_addr', 'mail_unit', 'mail_city', 'mail_st', 'mail_zip', 'do_not_mail',
  'unit', 'county', 'property_type', 'lot_sqft',
  'est_value', 'assessed_value', 'est_equity', 'ltv', 'open_loans', 'loan_balance', 'lien_amount', 'monthly_rent',
  'last_sale_date', 'last_sale_price', 'mls_status', 'mls_date', 'mls_amount', 'vacant', 'absentee', 'owner_occupied',
  'market', 'garage', 'occupancy', 'listed_mls', 'on_investorlift', 'portfolio', 'submitter',
]);

const LINK_HEADERS = new Set(['link', 'links', 'url', 'listinglink', 'listingurl', 'propertylink', 'propertyurl']);

/** Fact targets that hold dollars: a "%" column of the same name ("Est. Equity %") is not one of them. */
const MONEY_FACTS = new Set<Target>(['est_value', 'assessed_value', 'est_equity', 'loan_balance', 'lien_amount', 'monthly_rent', 'last_sale_price', 'mls_amount']);

const PHONE_WORD = '(phone|mobile|cell|cellphone|wireless|landline|telephone|tel)(?:number)?';
const PHONE_FLAG = '(type|linetype|dnc|donotcall|litigator|tcpa|status|carrier|connected|score)?';
const NUMBERED_PHONE = new RegExp(`^${PHONE_WORD}(\\d{1,2})${PHONE_FLAG}$`);
const PHONE_FLAG_NUMBER = new RegExp(`^${PHONE_WORD}${PHONE_FLAG}(\\d{1,2})$`);

/**
 * A numbered phone or email column the way list exports write them: "Phone 1",
 * "Phone1", "Mobile 2", "Landline 3", "Phone 2 Type", "Phone 3 DNC", "Phone 4
 * Litigator", "Phone Type 1", "Email 2". Null for anything else.
 */
export function numberedContact(header: string): Target | null {
  const n = norm(header).replace(/^(owner|seller|contact)(mailing)?/, '');
  const a = NUMBERED_PHONE.exec(n);
  const b = a ? null : PHONE_FLAG_NUMBER.exec(n);
  if (a || b) {
    const flag = a ? a[3] : b![2];
    if (!flag) return 'phone';
    if (/type/.test(flag)) return 'phone_type';
    if (/dnc|donotcall|litigator|tcpa/.test(flag)) return 'phone_dnc';
    return 'extra';
  }
  if (/^(email|emailaddress|mail)\d{1,2}$/.test(n)) return 'email';
  return null;
}

/**
 * Guess a target for every column.
 *
 * Header first: an exact alias wins (numbered phone and email columns by
 * their shape); otherwise the alias sharing the most tokens with the header.
 * Then the values: if the header told us nothing but most cells look like
 * phone numbers, it is a phone column. A target is assigned once, except the
 * ones several columns can feed (every phone, every email, notes, tags…): the
 * first phone column is the main number. Whatever is left is kept as extra
 * info, never dropped.
 */
export function autoMap(table: Table, kind: RecordKind = 'sellers', conf: Confidences = {}): Mapping {
  const aliases = Object.entries(ALIASES_BY_KIND[kind]) as [Exclude<Target, 'skip'>, string[]][];
  const taken = new Set<Target>();
  const mapping: Mapping = {};
  const sample = (i: number) => table.rows.slice(0, 40).map((r) => r[i]).filter((v) => v && v.trim());

  let pass = 1;
  const claim = (i: number, t: Target) => {
    if (t !== 'skip' && taken.has(t)) {
      if (t === 'phone' && kind !== 'vendors' && !taken.has('phone2')) t = 'phone2';
      else if (!MULTI_TARGETS.has(t)) return false;
    }
    mapping[i] = t;
    if (t !== 'skip') taken.add(t);
    conf[i] = pass === 1 ? 'high' : 'medium';
    return true;
  };

  const dgChipTarget = (n: string): Target | null => {
    for (const suffix of Object.keys(DG_CHIPS)) {
      const s = suffix.replace(/_/g, '');
      if (n === 'no' + s) return 'restrictions';
      if (n === 'req' + s) return 'requirements';
    }
    return null;
  };

  // Pass 1: exact header aliases.
  table.headers.forEach((h, i) => {
    // Podio writes a money field as "<label> - amount" plus "<label> - currency" ("US"), a
    // date as "<label> - start", and long questions with a note in brackets: "What price
    // are you asking? (Your contract price including your fee) - amount" is the asking price.
    if (/\s-\s*currency$/i.test(h)) { claim(i, 'skip'); return; }
    const n = norm(podioLabel(h));
    // A bare "Link" / "URL" on a seller or submission sheet is the house's listing or photos
    // (Mark Spain); matched on the exact header only, so "LinkedIn" or "Zillow URL" is not.
    if (kind === 'sellers' && LINK_HEADERS.has(n) && claim(i, 'photos')) return;
    if (kind === 'sellers' && n === 'location') {
      // "Location" is the address in some exports and the market ("Raleigh") in others.
      const vals = sample(i);
      const addressy = vals.length > 0 && vals.filter(looksLikeAddress).length / vals.length > 0.5;
      if (claim(i, addressy ? 'full_address' : 'market')) return;
    }
    if (kind !== 'vendors') {
      const numbered = numberedContact(h);
      // A buyer has no per-phone type or DNC field: those columns are kept as extra info.
      if (numbered) { claim(i, kind === 'sellers' || numbered === 'phone' || numbered === 'email' ? numbered : 'extra'); return; }
    }
    for (const [t, names] of aliases) {
      if (!names.includes(n)) continue;
      // "Est. Equity %" is not the equity in dollars.
      if (MONEY_FACTS.has(t) && /%|percent|pct/i.test(h)) break;
      claim(i, t);
      break;
    }
    if (i in mapping) return;
    // A mailing or second-owner column with no field of its own ("Mailing County",
    // "Mailing Care of Name") is kept as it is, never read as the property's.
    if (kind === 'sellers' && /^(mailing|mail|owner2|coowner|secondowner)/.test(n)) { claim(i, 'extra'); return; }
    if (kind === 'buyers') {
      if (n === 'type') {
        const vals = sample(i).join(' ').toLowerCase();
        if (/vetted|vip/.test(vals)) { claim(i, 'vetted'); return; }
      }
      const t = dgChipTarget(n); if (t) claim(i, t);
    }
  });

  pass = 2;
  // Pass 2: token overlap for anything still unmapped.
  table.headers.forEach((h, i) => {
    if (i in mapping) return;
    const toks = tokens(h);
    if (toks[0] === 'no' || toks[0] === 'req' || toks[0] === 'allow') return;
    let best: { t: Target; score: number } | null = null;
    for (const [t, names] of aliases) {
      if (kind === 'sellers' && EXACT_ONLY.has(t)) continue;
      for (const alias of names) {
        // A word inside another only counts when both are real words: "est" is not "st", "tax" is not "taxid".
        const hits = toks.filter((tok) => tok === alias || (Math.min(tok.length, alias.length) >= 4 && (alias.includes(tok) || tok.includes(alias)))).length;
        const score = hits / Math.max(1, toks.length);
        if (hits && (!best || score > best.score)) best = { t, score };
      }
    }
    if (best && best.score >= 0.5) claim(i, best.t);
  });

  // Pass 3: the values themselves.
  table.headers.forEach((h, i) => {
    if (i in mapping) return;
    const vals = sample(i);
    if (vals.length < 3) return;
    const share = (fn: (v: string) => boolean) => vals.filter(fn).length / vals.length;
    if (share(looksLikeEmail) > 0.6) claim(i, 'email');
    else if (share(looksLikePhone) > 0.6) claim(i, 'phone');
    else if (kind !== 'sellers') return;
    else if (share(looksLikeZip) > 0.7) claim(i, 'zip');
    else if (share(looksLikeState) > 0.7) claim(i, 'st');
    else if (share(looksLikeAddress) > 0.6) claim(i, 'full_address');
    // Money is only a guess at the asking price when the header says nothing
    // ("Col D"): a named money column with no field is kept as extra info.
    else if (share(looksLikeMoney) > 0.6 && /^(col(umn)?|field)?\s*[a-z0-9]{0,2}$/i.test(h.trim())) claim(i, 'asking');
  });

  table.headers.forEach((_, i) => { if (!(i in mapping)) { mapping[i] = 'extra'; conf[i] = 'low'; } });
  return mapping;
}

// ---- normalisation ----------------------------------------------------------

export type ImportRecord = {
  name: string; phone: string | null; phone2: string | null; email: string | null;
  addr: string | null; city: string | null; st: string | null; zip: string | null;
  beds: number | null; baths: number | null; sqft: number | null; year: number | null; apn: string | null;
  asking: number | null; arv: number | null; rehab: number | null; offer: number | null;
  stage: string | null; motivation: string | null; source: string | null; tags: string[]; notes: string | null;
  created: string | null; source_id: string | null;
  /** Photo links from the file; they land on the lead's deal as photos (deal_files). */
  photos: string[];
  /** The partner company that sent the row (Podio's "Entity Name"): a vendor submission's vendor. */
  submitter?: string | null;
  /** The main phone's type and do-not-call / litigator flag, from its "Phone 1 Type" / "Phone 1 DNC" columns. */
  phoneKind: string | null; phoneDnc: boolean;
  /** Every phone after the main one, in file order, with its type and flag (seller_phones, position 2+). */
  otherPhones: FoundPhone[];
  /** Every email after the first, in file order (sellers.other_emails). */
  otherEmails: string[];
  owner2: string | null;
  mailing: { line1: string | null; city: string | null; st: string | null; zip: string | null } | null;
  doNotMail: boolean | null;
  county: string | null; propertyType: string | null; lotSqft: number | null;
  /** What the list says about the house with no column of its own (properties.facts). */
  facts: PropertyFacts;
  /** Every column kept as extra info, by its header (sellers.import_extra, or the notes). */
  extra: Record<string, string>;
  /** Why this row will be skipped, when it will. */
  problem: string | null;
};

/**
 * A money cell as whole dollars (lib/money): "$189K" is 189,000 and a range
 * ("$150,000 - $175,000") is its low end; `range` says it was one, so the row
 * keeps the cell as extra info. Text around a number ("about 150k") reads the
 * first amount in it. Zero and unreadable cells are null.
 */
export function importMoney(v: string | undefined): { value: number | null; range: boolean } {
  const t = (v ?? '').trim();
  if (!t) return { value: null, range: false };
  let r = parseDollarRange(t);
  if (r.error) {
    // Only something that reads as money: a $, a k/m, or thousands with commas.
    // A phone number or "3 bed" in the cell is not a price.
    const hit = /\$\s?\d[\d,]*(?:\.\d+)?\s?[km]?\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s?[km]\b/i.exec(t);
    r = hit ? parseDollarRange(hit[0]) : r;
  }
  if (r.error || r.low == null || r.low === 0) return { value: null, range: false };
  return { value: r.low, range: r.high != null && r.high !== r.low };
}
const money = (v: string | undefined) => importMoney(v).value;
const int = (v: string | undefined) => {
  const n = Number((v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** "123 Oak St, San Antonio, TX 78254" → parts. Also "123 Oak St San Antonio TX 78254". */
export function splitFullAddress(raw: string): { addr: string; city: string | null; st: string | null; zip: string | null } {
  const s = raw.trim().replace(/\s+/g, ' ');
  const m = /^(.*?)[,\s]+([A-Za-z .'-]+?)[,\s]+([A-Za-z]{2})[,\s]+(\d{5}(?:-\d{4})?)$/.exec(s);
  if (m) return { addr: m[1].replace(/,$/, '').trim(), city: m[2].trim(), st: m[3].toUpperCase(), zip: m[4] };
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const tail = /([A-Za-z]{2})?\s*(\d{5}(?:-\d{4})?)?$/.exec(parts[parts.length - 1] ?? '');
    return { addr: parts[0], city: parts[1] && parts.length > 2 ? parts[1] : (parts.length === 2 ? null : parts[1]), st: tail?.[1]?.toUpperCase() ?? null, zip: tail?.[2] ?? null };
  }
  return { addr: s, city: null, st: null, zip: null };
}

/** Whatever the source called it, the pipeline has a name for it. */
function normaliseStage(v: string | null): string | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (/closed|sold|complete/.test(s)) return 'Closed';
  if (/assign/.test(s)) return 'Assigned';
  if (/closing|title|escrow/.test(s)) return 'Closing';
  if (/dispo|market/.test(s)) return 'Dispo';
  if (/under contract|contract|uc\b/.test(s)) return 'Under Contract';
  if (/negot/.test(s)) return 'Negotiation';
  if (/offer/.test(s)) return 'Offer Sent';
  if (/appt|appointment|walk/.test(s)) return 'Appointment';
  if (/qualif|hot|warm/.test(s)) return 'Qualified';
  if (/contact|called|reached|follow/.test(s)) return 'Contacted';
  if (/dead|lost|not interested|dnc|do not/.test(s)) return 'Lost';
  if (/new|lead|cold/.test(s)) return 'New Lead';
  return null;
}

// ---- what a row carries beyond the core fields ---------------------------------

/** Each column's key in the extra-info bag: its header, made unique ("Notes (2)"), "Column 7" when it has none. */
export function headerKeys(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** Columns by target, in file order. */
function columnsOf(mapping: Mapping): Partial<Record<Target, number[]>> {
  const idx: Partial<Record<Target, number[]>> = {};
  for (const [i, t] of Object.entries(mapping)) (idx[t] ??= []).push(Number(i));
  for (const k of Object.keys(idx) as Target[]) idx[k]!.sort((a, b) => a - b);
  return idx;
}

/**
 * The extra-info bag for one row: every column kept as extra info that has a
 * value, by its header, and — so two columns mapped to one single-value field
 * never lose one — the value of a further column on such a field when it
 * differs from the one used. `readsAll` are the targets whose every column is
 * already used.
 */
function extrasOf(row: string[], keys: string[], cols: Partial<Record<Target, number[]>>, readsAll: ReadonlySet<Target>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of cols.extra ?? []) { const v = (row[i] ?? '').trim(); if (v) out[keys[i]] = v; }
  for (const [t, is] of Object.entries(cols) as [Target, number[]][]) {
    if (t === 'extra' || t === 'skip' || readsAll.has(t) || is.length < 2) continue;
    const used = is.map((i) => (row[i] ?? '').trim()).find(Boolean);
    for (const i of is) { const v = (row[i] ?? '').trim(); if (v && v !== used && !(keys[i] in out)) out[keys[i]] = v; }
  }
  return out;
}

const PHONE_IN_TEXT = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
/** One cell's phones: usually one, sometimes "210-555-0100, 512-555-0111". */
export function phonesIn(cell: string | undefined): string[] {
  const t = (cell ?? '').trim();
  const hits = t.match(PHONE_IN_TEXT) ?? [];
  return hits.length > 1 ? hits.map((h) => h.trim()) : t ? [t] : [];
}
/** "Wireless", "Mobile", "Landline", "VOIP", or what the header says ("Landline 2"). */
function phoneKindOf(v: string | undefined, header: string): string | null {
  const t = (v ?? '').trim().toLowerCase();
  if (t) {
    if (/mobile|wireless|cell/.test(t)) return 'mobile';
    if (/land|residential|fixed|home/.test(t)) return 'landline';
    if (/voip/.test(t)) return 'voip';
    return t.slice(0, 30);
  }
  const h = norm(header);
  if (/^(landline|home|work)/.test(h)) return 'landline';
  if (/^(mobile|cell|wireless)/.test(h)) return 'mobile';
  return null;
}
/** A DNC or litigator cell: "Yes", "Y", "DNC", "Litigator", "True", "1". */
function isFlagged(v: string | undefined): boolean {
  const t = (v ?? '').trim();
  if (!t) return false;
  const b = asBool(t);
  if (b != null) return b;
  return /dnc|do\s*not\s*call|litigator|registered|blocked/i.test(t) && !/^(not|no|clean|ok)\b/i.test(t);
}

/**
 * Which column is the main phone, the order of the rest, and which type and
 * DNC / litigator columns belong to which phone: the one with the same number
 * in its header ("Phone 2 DNC" → "Phone 2"), else the nearest phone column to
 * its left.
 */
export function planPhoneColumns(headers: string[], mapping: Mapping) {
  const all = Object.entries(mapping).filter(([, t]) => t === 'phone' || t === 'phone2').map(([i]) => Number(i)).sort((a, b) => a - b);
  const main = all.find((i) => mapping[i] === 'phone');
  const order = main == null ? all : [main, ...all.filter((i) => i !== main)];
  const num = (h: string | undefined) => /(\d{1,2})/.exec(h ?? '')?.[1] ?? null;
  const ownerOf = (j: number): number | undefined => {
    const n = num(headers[j]);
    const byNumber = n ? all.find((i) => num(headers[i]) === n) : undefined;
    if (byNumber != null) return byNumber;
    const left = all.filter((i) => i < j);
    return left.length ? left[left.length - 1] : all[0];
  };
  const typeOf = new Map<number, number[]>();
  const dncOf = new Map<number, number[]>();
  for (const [i, t] of Object.entries(mapping)) {
    if (t !== 'phone_type' && t !== 'phone_dnc') continue;
    const owner = ownerOf(Number(i));
    if (owner == null) continue;
    const m = t === 'phone_type' ? typeOf : dncOf;
    m.set(owner, [...(m.get(owner) ?? []), Number(i)]);
  }
  return { order, typeOf, dncOf };
}

/** Every phone in a row, main first, then file order, each number once (a repeat's DNC flag is kept). */
function phonesOfRow(row: string[], headers: string[], plan: ReturnType<typeof planPhoneColumns>): FoundPhone[] {
  const out: FoundPhone[] = [];
  const at = new Map<string, number>();
  for (const i of plan.order) {
    const kindCols = plan.typeOf.get(i) ?? [];
    const kind = phoneKindOf(kindCols.map((k) => row[k]).find((v) => v && v.trim()), headers[i] ?? '');
    const dnc = (plan.dncOf.get(i) ?? []).some((k) => isFlagged(row[k]));
    for (const phone of phonesIn(row[i])) {
      const key = toE164(phone) ?? phone.replace(/\D/g, '') ?? phone;
      const seen = at.get(key);
      if (seen != null) { if (dnc) out[seen].dnc = true; continue; }
      at.set(key, out.length);
      out.push({ phone, kind, dnc });
    }
  }
  return out;
}

/** Every email in the row's email columns, in order, each once. A cell with no address in it is kept as written. */
function emailsOfRow(row: string[], cols: number[]): string[] {
  const out: string[] = [];
  for (const i of cols) {
    const t = (row[i] ?? '').trim();
    if (!t) continue;
    const found = t.split(/[\s,;]+/).filter((x) => x.includes('@'));
    for (const e of found.length ? found : [t]) if (!out.some((x) => x.toLowerCase() === e.toLowerCase())) out.push(e);
  }
  return out;
}

/** A number as a list writes it: "$1,234", "-5,000", "65%", "0". Zero is a value here (no equity, no loans). */
const amount = (v: string | undefined): number | null => {
  const t = (v ?? '').replace(/[^0-9.-]/g, '');
  if (!t || t === '-' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
/** "3/14/2019", "2019-03-14T00:00" → "2019-03-14"; anything else as written. */
export function isoDay(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(t);
  if (us) {
    const y = us[3].length === 2 ? (Number(us[3]) >= 50 ? 1900 : 2000) + Number(us[3]) : Number(us[3]);
    return `${y}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  return t;
}
/** Yes / no when the cell says so, its own words otherwise ("Vacant", "Likely"). */
const flagOrText = (v: string | undefined): boolean | string | null => {
  const t = (v ?? '').trim();
  if (!t) return null;
  return asBool(t) ?? t;
};
/** "123 Oak St" + "4" → "123 Oak St #4"; "Apt 4" is added as it is; a unit already on the line is not added twice. */
export function withUnit(line: string | null, unit: string | undefined): string | null {
  const u = (unit ?? '').trim();
  if (!line || !u) return line;
  const bare = u.replace(/^(#|unit|apt\.?|apartment|ste\.?|suite)\s*/i, '');
  if (bare && new RegExp(`(#|\\bunit|\\bapt\\.?|\\bste\\.?|\\bsuite)\\s*${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(line)) return line;
  return /^[#a-z]/i.test(u) ? `${line} ${u}` : `${line} #${u}`;
}

const text = (v: string | undefined) => (v ?? '').trim() || null;

/** The fact targets and how each is read. */
const FACT_READ: [Target, keyof PropertyFacts, (v: string | undefined) => number | string | boolean | null][] = [
  ['est_value', 'est_value', amount], ['assessed_value', 'assessed_value', amount], ['est_equity', 'est_equity', amount],
  ['ltv', 'ltv', amount], ['open_loans', 'open_loans', amount], ['loan_balance', 'loan_balance', amount],
  ['lien_amount', 'lien_amount', amount], ['monthly_rent', 'monthly_rent', amount],
  ['last_sale_date', 'last_sale_date', isoDay], ['last_sale_price', 'last_sale_price', amount],
  ['mls_status', 'mls_status', text], ['mls_date', 'mls_date', isoDay], ['mls_amount', 'mls_amount', amount],
  ['vacant', 'vacant', flagOrText], ['absentee', 'absentee', flagOrText], ['owner_occupied', 'owner_occupied', flagOrText],
  ['market', 'market', text], ['garage', 'garage', text], ['occupancy', 'occupancy', flagOrText],
  ['listed_mls', 'listed_mls', flagOrText], ['on_investorlift', 'on_investorlift', flagOrText], ['portfolio', 'portfolio', text],
];

/** Seller targets whose every column is read (the rest use the first with a value). */
const SELLER_READS_ALL = new Set<Target>(['phone', 'phone2', 'phone_type', 'phone_dnc', 'email', 'tags', 'notes', 'photos']);

export function applyMapping(table: Table, mapping: Mapping): ImportRecord[] {
  const cols = columnsOf(mapping);
  const keys = headerKeys(table.headers);
  const phonePlan = planPhoneColumns(table.headers, mapping);
  const getAt = (row: string[], t: Target) => (cols[t] ?? []).map((i) => row[i]).find((v) => v && v.trim()) ?? undefined;
  const get = (row: string[], t: Target) => getAt(row, t)?.trim() || undefined;

  return table.rows.map((row) => {
    const first = get(row, 'first_name');
    const last = get(row, 'last_name');
    const name = get(row, 'name') ?? [first, last].filter(Boolean).join(' ').trim();

    let addr = get(row, 'addr') ?? null;
    let city = get(row, 'city') ?? null;
    let st = get(row, 'st') ?? null;
    let zip = get(row, 'zip') ?? null;
    const full = get(row, 'full_address');
    if (full && !addr) {
      const p = splitFullAddress(full);
      addr = p.addr; city = city ?? p.city; st = st ?? p.st; zip = zip ?? p.zip;
    } else if (full && addr && !city) {
      const p = splitFullAddress(full);
      city = p.city; st = st ?? p.st; zip = zip ?? p.zip;
    }
    addr = withUnit(addr, get(row, 'unit'));
    // No name stays no name: an address is never a seller's name (migration 47).
    // The city column holds only the city and the state is a code: "San
    // Antonio Tx" in a City column is San Antonio, TX (lib/place-names).
    const place = normalizePlace({ city, state: st, zip });
    city = place.city; st = place.state; zip = place.zip;

    // The owner's mailing address: its own columns, or one column holding all of it.
    let mLine = get(row, 'mail_addr') ?? null;
    let mCity = get(row, 'mail_city') ?? null;
    let mSt = get(row, 'mail_st') ?? null;
    let mZip = get(row, 'mail_zip') ?? null;
    if (mLine && !mCity && !mSt && !mZip) {
      const p = splitFullAddress(mLine);
      mLine = p.addr; mCity = p.city; mSt = p.st; mZip = p.zip;
    }
    mLine = withUnit(mLine, get(row, 'mail_unit'));
    const mPlace = normalizePlace({ city: mCity, state: mSt, zip: mZip });
    const mailing = mLine || mPlace.city || mPlace.state || mPlace.zip ? { line1: mLine, city: mPlace.city, st: mPlace.state, zip: mPlace.zip } : null;
    const dnm = get(row, 'do_not_mail');

    const phones = phonesOfRow(row, table.headers, phonePlan);
    const emails = emailsOfRow(row, cols.email ?? []);
    const phone = phones[0]?.phone ?? null;
    const problem = !name && !addr && !phone ? 'No name, address or phone' : null;
    const tagsRaw = (cols.tags ?? []).map((i) => row[i] ?? '').join(',');
    // Several notes columns are kept as they are, each under its header.
    const notesCols = (cols.notes ?? []).filter((i) => (row[i] ?? '').trim());
    const notes = notesCols.length > 1 ? notesCols.map((i) => `${keys[i]}: ${row[i].trim()}`).join('\n') : notesCols.length ? row[notesCols[0]].trim() : null;
    const lotRaw = get(row, 'lot_sqft');
    const lotCol = (cols.lot_sqft ?? []).find((i) => (row[i] ?? '').trim());
    const acres = lotRaw != null && (/acre|\bac\b/i.test(lotRaw) || /acre/i.test(table.headers[lotCol ?? -1] ?? ''));
    const lot = amount(lotRaw);
    const bathsN = amount(get(row, 'baths'));

    const facts: PropertyFacts = {};
    for (const [t, key, read] of FACT_READ) {
      const v = read(get(row, t));
      if (v != null && v !== '') (facts as Record<string, unknown>)[key] = v;
    }
    const owner2First = get(row, 'owner2_first');
    const asking = importMoney(get(row, 'asking'));
    const owner2Last = get(row, 'owner2_last');

    return {
      name: name || '',
      phone, phone2: phones[1]?.phone ?? null, email: emails[0] ?? null,
      addr, city, st, zip,
      beds: int(get(row, 'beds')), baths: bathsN != null && bathsN > 0 ? Math.round(bathsN * 100) / 100 : null,
      sqft: int(get(row, 'sqft')), year: int(get(row, 'year')),
      apn: get(row, 'apn') ?? null,
      asking: asking.value, arv: money(get(row, 'arv')), rehab: money(get(row, 'rehab')), offer: money(get(row, 'offer')),
      stage: normaliseStage(get(row, 'stage') ?? null),
      motivation: get(row, 'motivation') ?? null, source: get(row, 'source') ?? null,
      tags: [...new Set(tagsRaw.split(/[,;|]/).map((t) => t.trim()).filter(Boolean))],
      notes,
      created: parseDue(get(row, 'created')) ?? null,
      source_id: get(row, 'source_id')?.trim() || null,
      photos: [...new Set((cols.photos ?? []).flatMap((i) => parseLinks(row[i] ?? '')))],
      submitter: get(row, 'submitter') ?? null,
      phoneKind: phones[0]?.kind ?? null, phoneDnc: !!phones[0]?.dnc,
      otherPhones: phones.slice(1),
      otherEmails: emails.slice(1),
      owner2: get(row, 'owner2_name') ?? ([owner2First, owner2Last].filter(Boolean).join(' ') || null),
      mailing,
      doNotMail: dnm == null ? null : asBool(dnm) ?? /dnm|do\s*not\s*mail|yes/i.test(dnm),
      county: get(row, 'county') ?? null,
      propertyType: get(row, 'property_type') ?? null,
      lotSqft: lot != null && lot > 0 ? Math.round(acres ? lot * 43560 : lot) : null,
      facts,
      // A range keeps the whole cell, so the high end is not lost when the low end is saved.
      extra: { ...extrasOf(row, keys, cols, SELLER_READS_ALL), ...(asking.range ? { 'Asking price range': (get(row, 'asking') ?? '').trim() } : {}) },
      problem,
    };
  });
}

/** Column lookup shared by the buyer and vendor mappers. */
function getter(mapping: Mapping) {
  const idx: Partial<Record<Target, number[]>> = {};
  for (const [i, t] of Object.entries(mapping)) if (t !== 'skip') (idx[t] ??= []).push(Number(i));
  return (row: string[], t: Target) => (idx[t] ?? []).map((i) => row[i]).find((v) => v && v.trim())?.trim() || null;
}
const list = (v: string | null) => (v ?? '').split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
/** "$100K", "1.2M", "250,000" → a number. "$100K - $350K" → both ends. */
function prices(v: string | null): number[] {
  return ((v ?? '').match(/\d[\d,.]*\s*[kKmM]?/g) ?? []).map((n) => {
    const base = Number(n.replace(/[^0-9.]/g, ''));
    return /[kK]/.test(n) ? base * 1000 : /[mM]/.test(n) ? base * 1_000_000 : base;
  }).filter((n) => Number.isFinite(n) && n > 0);
}
const code = (v: string | null) => (v ? v.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || null : null);

export type BuyerImportRecord = {
  name: string; company: string | null; phone: string | null; phone2: string | null; email: string | null; website: string | null;
  buyer_type: string | null; entity_type: string | null; preferred_channel: string | null; vip: boolean | null;
  vetted: boolean | null; blacklisted: boolean | null; wants_calls: boolean | null; wants_follow_ups: boolean | null;
  markets: string[]; min_price: number | null; max_price: number | null; buy_box: string | null;
  strategies: string[]; property_types: string[]; min_beds: number | null; min_baths: number | null;
  min_sqft: number | null; max_sqft: number | null; min_year: number | null; max_year: number | null;
  min_lot: number | null; max_lot: number | null; funding: string[]; timeline: number | null;
  restrictions: string[]; requirements: string[];
  tags: string[]; notes: string | null; source_id: string | null; problem: string | null;
  /** Every phone after the first two and every email after the first, kept in the notes. */
  otherPhones: string[]; otherEmails: string[];
  /** Every column kept as extra info, by its header (kept in the notes). */
  extra: Record<string, string>;
};

const asBool = (v: string | null): boolean | null => {
  if (v == null || v.trim() === '') return null;
  if (/^(y|yes|true|1|1\.0|x|vip)$/i.test(v.trim())) return true;
  if (/^(n|no|false|0|0\.0)$/i.test(v.trim())) return false;
  return null;
};
const codes = (raw: string[], map: Record<string, string>) =>
  [...new Set(raw.flatMap((v) => list(v)).map((s) => codeOf(s, map)).filter((c): c is string => !!c))];
function chipsFrom(header: string, value: string): string[] {
  const n = norm(header);
  const on = asBool(value) === true;
  for (const [suffix, chip] of Object.entries(DG_CHIPS)) {
    const s = suffix.replace(/_/g, '');
    if (n === 'no' + s) return on ? [chip] : [];
    if (n === 'req' + s) return on ? [chip] : [];
  }
  return list(value).map((s) => RESTRICTION_MAP[s.toLowerCase()] ?? codeOf(s, RESTRICTION_MAP)).filter((c): c is string => !!c);
}

export function applyBuyerMapping(table: Table, mapping: Mapping): BuyerImportRecord[] {
  const colsOf = (t: Target) => Object.entries(mapping).filter(([, x]) => x === t).map(([i]) => Number(i));
  const get = (row: string[], t: Target) => colsOf(t).map((i) => row[i]).find((v) => v && v.trim())?.trim() || null;
  const getAll = (row: string[], t: Target) => colsOf(t).map((i) => row[i]?.trim()).filter(Boolean);
  const flagAt = (row: string[], t: Target): boolean | null => {
    for (const i of colsOf(t)) {
      const header = table.headers[i] ?? '';
      const raw = (row[i] ?? '').trim();
      if (/vetted|vip/i.test(raw) && t === 'vetted') return true;
      if (/vip/i.test(raw) && t === 'vip') return true;
      const b = asBool(raw);
      if (b == null) continue;
      const invert = t === 'wants_calls' ? /\bdnd\b|donot|no.?call/i.test(header)
        : t === 'wants_follow_ups' ? /no.?follow/i.test(header) : false;
      return invert ? !b : b;
    }
    return null;
  };

  const cols = columnsOf(mapping);
  const keys = headerKeys(table.headers);
  const phonePlan = planPhoneColumns(table.headers, mapping);
  const BUYER_READS_ALL = new Set<Target>(['phone', 'phone2', 'email', 'strategy', 'property_type', 'funding', 'restrictions', 'requirements', 'markets', 'tags', 'notes']);
  const joined = (row: string[], t: Target) => colsOf(t).map((i) => row[i]?.trim()).filter(Boolean).join(', ') || null;

  return table.rows.map((row) => {
    const company = get(row, 'company');
    const phones = phonesOfRow(row, table.headers, phonePlan).map((p) => p.phone as string);
    const emails = emailsOfRow(row, cols.email ?? []);
    const notesCols = colsOf('notes').filter((i) => (row[i] ?? '').trim());
    const name = get(row, 'name') || [get(row, 'first_name'), get(row, 'last_name')].filter(Boolean).join(' ') || company;
    const phone = phones[0] ?? null; const email = emails[0] ?? null;
    const minP = prices(get(row, 'min_price')); const maxP = prices(get(row, 'max_price'));
    const ch = get(row, 'preferred_channel');
    const strategies = codes(getAll(row, 'strategy'), STRATEGY_MAP);
    const property_types = codes(getAll(row, 'property_type'), TYPE_MAP);
    const only = strategies.length === 1 ? strategies[0] : null;
    const buyer_type = buyerTypeCode(get(row, 'buyer_type'))
      ?? (only === 'fix_and_flip' ? 'flipper' : only === 'buy_and_hold' ? 'landlord' : only === 'new_construction' ? 'developer' : strategies.length ? 'investor' : null);
    const restrictions = [...new Set(colsOf('restrictions').flatMap((i) => chipsFrom(table.headers[i] ?? '', row[i] ?? '')))];
    const requirements = [...new Set(colsOf('requirements').flatMap((i) => chipsFrom(table.headers[i] ?? '', row[i] ?? '')))];
    const timelineRaw = get(row, 'timeline');
    const timeline = timelineRaw ? int(timelineRaw.replace(/\D+/g, ' ').trim().split(' ')[0]) : null;
    return {
      name: name || '—', company, phone, phone2: phones[1] ?? null, email: email?.toLowerCase() ?? null, website: get(row, 'website'),
      buyer_type, entity_type: code(get(row, 'entity_type')),
      preferred_channel: !ch ? null : CHANNEL_MAP[ch.toLowerCase()] ?? (/sms|text/.test(ch) && !/email/.test(ch) ? 'sms_only' : /email/.test(ch) && !/sms|text/.test(ch) ? 'email_only' : 'email_and_sms'),
      vip: flagAt(row, 'vip') ?? (colsOf('vetted').some((i) => /vip/i.test(row[i] ?? '')) ? true : null), vetted: flagAt(row, 'vetted') || (colsOf('vetted').some((i) => /vip/i.test(row[i] ?? '')) ? true : null),
      blacklisted: flagAt(row, 'blacklisted'), wants_calls: flagAt(row, 'wants_calls'), wants_follow_ups: flagAt(row, 'wants_follow_ups'),
      markets: normalizeMarkets(list(joined(row, 'markets'))),
      min_price: minP.length ? Math.min(...minP) : maxP.length > 1 ? Math.min(...maxP) : null,
      max_price: maxP.length ? Math.max(...maxP) : null,
      buy_box: get(row, 'buy_box'),
      strategies, property_types,
      min_beds: int(get(row, 'min_beds') ?? undefined), min_baths: int(get(row, 'min_baths') ?? undefined),
      min_sqft: int(get(row, 'min_sqft') ?? undefined), max_sqft: int(get(row, 'max_sqft') ?? undefined),
      min_year: int(get(row, 'min_year') ?? undefined), max_year: int(get(row, 'max_year') ?? undefined),
      min_lot: int(get(row, 'min_lot') ?? undefined), max_lot: int(get(row, 'max_lot') ?? undefined),
      funding: codes(getAll(row, 'funding'), FUNDING_MAP), timeline,
      restrictions, requirements,
      tags: [...new Set(list(joined(row, 'tags')))],
      notes: notesCols.length > 1 ? notesCols.map((i) => `${keys[i]}: ${row[i].trim()}`).join('\n') : notesCols.length ? row[notesCols[0]].trim() : null,
      source_id: get(row, 'source_id'),
      problem: name ? null : !phone && !email ? 'No name, phone or email' : 'No name or company',
      otherPhones: phones.slice(2), otherEmails: emails.slice(1).map((e) => e.toLowerCase()),
      extra: extrasOf(row, keys, cols, BUYER_READS_ALL),
    };
  });
}

export type VendorImportRecord = {
  name: string; contact_name: string | null; phone: string | null; email: string | null;
  service_type: string | null; markets: string[]; notes: string | null; problem: string | null;
  /** Every phone and email after the first, and every column kept as extra info: kept in the notes. */
  otherPhones: string[]; otherEmails: string[]; extra: Record<string, string>;
};

export function applyVendorMapping(table: Table, mapping: Mapping): VendorImportRecord[] {
  const get = getter(mapping);
  const cols = columnsOf(mapping);
  const keys = headerKeys(table.headers);
  const all = (row: string[], t: Target) => (cols[t] ?? []).map((i) => (row[i] ?? '').trim()).filter(Boolean);
  return table.rows.map((row) => {
    const contact = get(row, 'contact_name');
    const name = get(row, 'name') || contact;
    const phones = all(row, 'phone').flatMap((v) => phonesIn(v));
    const emails = emailsOfRow(row, cols.email ?? []);
    return {
      name: name || '—', contact_name: contact, phone: phones[0] ?? null, email: emails[0]?.toLowerCase() ?? null,
      service_type: get(row, 'service_type'), markets: normalizeMarkets(list(all(row, 'markets').join(', '))), notes: all(row, 'notes').join('\n') || null,
      problem: name ? null : 'No business or contact name',
      otherPhones: [...new Set(phones.slice(1))], otherEmails: emails.slice(1).map((e) => e.toLowerCase()),
      extra: extrasOf(row, keys, cols, new Set<Target>(['phone', 'email', 'markets', 'notes'])),
    };
  });
}

// ---- per-kind shape -----------------------------------------------------------

export type AnyRecord = ImportRecord | BuyerImportRecord | VendorImportRecord;

export function applyFor(kind: RecordKind, table: Table, mapping: Mapping): AnyRecord[] {
  return kind === 'buyers' ? applyBuyerMapping(table, mapping) : kind === 'vendors' ? applyVendorMapping(table, mapping) : applyMapping(table, mapping);
}

const phoneOut = (v: string | null) => (v ? toE164(v) ?? v : null);
const usd = (n: number | null) => (n ? '$' + n.toLocaleString() : null);

/** The preview columns, with values already normalised the way they will be written. */
export const PREVIEW_COLS: Record<RecordKind, string[]> = {
  sellers: ['Name', 'Phone', 'Email', 'Address', 'City', 'St', 'ZIP', 'Asking', 'Stage', 'Created', 'Also kept'],
  buyers: ['Name', 'Company', 'Phone', 'Email', 'Type', 'Markets', 'Price', 'VIP', 'Also kept'],
  vendors: ['Business', 'Contact', 'Phone', 'Email', 'Service', 'Markets', 'Also kept'],
};
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** What a row brings beyond the preview's columns, in a few words: "+2 phones · +1 email · mailing · 14 facts · 3 extra". */
export function keptSummary(rec: AnyRecord): string | null {
  const r = rec as Partial<ImportRecord> & { otherPhones?: unknown[]; otherEmails?: string[]; extra?: Record<string, string> };
  const parts = [
    r.otherPhones?.length ? '+' + plural(r.otherPhones.length, 'phone') : '',
    r.otherEmails?.length ? '+' + plural(r.otherEmails.length, 'email') : '',
    r.owner2 ? 'owner 2' : '',
    r.mailing ? 'mailing address' : '',
    r.facts && Object.keys(r.facts).length ? plural(Object.keys(r.facts).length, 'property fact') : '',
    r.extra && Object.keys(r.extra).length ? `${Object.keys(r.extra).length} extra` : '',
  ].filter(Boolean);
  return parts.join(' · ') || null;
}
export function previewCells(kind: RecordKind, rec: AnyRecord): (string | null)[] {
  if (kind === 'buyers') {
    const r = rec as BuyerImportRecord;
    return [r.name, r.company, phoneOut(r.phone), r.email, r.buyer_type, r.markets.join(', ') || null,
      r.min_price || r.max_price ? `${usd(r.min_price) ?? '$0'} – ${usd(r.max_price) ?? 'no max'}` : null, r.vip == null ? null : r.vip ? 'Yes' : 'No', keptSummary(r)];
  }
  if (kind === 'vendors') {
    const r = rec as VendorImportRecord;
    return [r.name, r.contact_name, phoneOut(r.phone), r.email, r.service_type, r.markets.join(', ') || null, keptSummary(r)];
  }
  const r = rec as ImportRecord;
  return [r.name, phoneOut(r.phone), r.email?.toLowerCase() ?? null, r.addr, r.city, r.st, r.zip, usd(r.asking), r.stage, r.created?.slice(0, 10) ?? null, keptSummary(r)];
}

/** "Key: value" lines for what a buyer or vendor row has no column for: other phones and emails, extra columns. */
export function extraNoteLines(r: { otherPhones: string[]; otherEmails: string[]; extra: Record<string, string> }, phonesShown: string[] = []): string[] {
  const phones = [...phonesShown, ...r.otherPhones.map((p) => phoneOut(p) ?? p)].filter(Boolean);
  return [
    phones.length ? 'Other phones: ' + [...new Set(phones)].join(', ') : '',
    r.otherEmails.length ? 'Other emails: ' + r.otherEmails.join(', ') : '',
    ...Object.entries(r.extra).map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean);
}

/**
 * The seller columns an import row fills beyond the core ones (migration 134),
 * only those with a value, so a file without them writes exactly what it did
 * before.
 */
export function sellerImportColumns(r: ImportRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (r.mailing?.line1) out.mailing_line1 = r.mailing.line1;
  if (r.mailing?.city) out.mailing_city = r.mailing.city;
  if (r.mailing?.st) out.mailing_state = r.mailing.st;
  if (r.mailing?.zip) out.mailing_zip = r.mailing.zip;
  if (r.doNotMail != null) out.do_not_mail = r.doNotMail;
  if (r.owner2) out.owner2_name = r.owner2;
  const emails = [...new Set(r.otherEmails.map((e) => e.toLowerCase()).filter((e) => e !== r.email?.toLowerCase()))];
  if (emails.length) out.other_emails = emails;
  if (Object.keys(r.extra).length) out.import_extra = r.extra;
  return out;
}

/** The property columns an import row fills, only those with a value; `facts` is the bag for the rest (migration 134). */
export function propertyImportFields(r: ImportRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    beds: r.beds, baths: r.baths, sqft: r.sqft, year_built: r.year, apn: r.apn,
    property_type: r.propertyType, county: r.county, lot_sqft: r.lotSqft,
  };
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  if (Object.keys(r.facts).length) out.facts = r.facts;
  return out;
}

/**
 * The property for an import row: found by the database's address_key, or
 * created. Found, it takes the row's house facts by the row's rule — `fill`
 * (a new seller, Add new info) only where it has none, `overwrite` wherever
 * the file has a value — never a blank. A database without migration 134 gets
 * everything but `facts`.
 */
export async function importProperty(workspaceId: number, r: ImportRecord, mode: 'fill' | 'overwrite'): Promise<number | null> {
  if (!supabase || !r.addr) return null;
  const sb = supabase;
  const parts = { line1: r.addr, ...normalizePlace({ city: r.city, state: r.st, zip: r.zip }) };
  const fields = propertyImportFields(r);
  const noFacts = (x: Record<string, unknown>) => { const y = { ...x }; delete y.facts; return y; };
  const { data: key } = await sb.rpc('address_key', { p_line1: parts.line1, p_city: parts.city ?? '', p_state: parts.state ?? '', p_zip: parts.zip ?? '' });
  if (key) {
    const { data: hit } = await sb.from('properties').select('*').eq('workspace_id', workspaceId).eq('address_key', key as string).order('id').limit(1);
    const cur = hit?.[0] as Record<string, unknown> | undefined;
    if (cur) {
      let patch = mergePatch(cur, fields, mode, { lists: [], append: [], objects: ['facts'] });
      if (!('facts' in cur)) patch = noFacts(patch);
      if (Object.keys(patch).length) {
        const { error } = await sb.from('properties').update(patch as never).eq('id', cur.id as number).eq('workspace_id', workspaceId);
        if (error && 'baths' in patch) await sb.from('properties').update({ ...noFacts(patch), baths: Math.round(Number(patch.baths)) } as never).eq('id', cur.id as number).eq('workspace_id', workspaceId);
      }
      return cur.id as number;
    }
  }
  const insert = (x: Record<string, unknown>) => sb.from('properties').insert({ workspace_id: workspaceId, ...parts, source: 'import', ...x } as never).select('id').single();
  let res = await insert(fields);
  if (res.error && isMissingColumn(res.error, ['facts'])) res = await insert(noFacts(fields));
  // A whole-number baths column (2.5 baths) on an older database.
  if (res.error && fields.baths != null) res = await insert({ ...noFacts(fields), baths: Math.round(Number(fields.baths)) });
  if (res.error) res = await insert({});
  return res.error ? null : (res.data as { id: number }).id;
}

/** Rows per import_property_batch / import_address_lookup call. The functions cap at 500. */
export const IMPORT_PROPERTY_BATCH = 400;

export type ImportPropertyHit = { propertyId: number | null; addressKey: string | null };

/**
 * Match a batch of import rows to properties in one call per 400 rows.
 * `write` finds or creates (import_property_batch). Otherwise it only looks
 * up (import_address_lookup). Null when the function is missing or errors,
 * so the caller can keep the per-row path. A later batch that fails returns
 * the hits already written, and the caller fills the gaps one row at a time.
 */
export async function resolveImportProperties(
  workspaceId: number,
  rows: { i: number; r: ImportRecord; mode: 'fill' | 'overwrite' }[],
  write: boolean,
): Promise<Map<number, ImportPropertyHit> | null> {
  if (!supabase) return null;
  const sb = supabase;
  const map = new Map<number, ImportPropertyHit>();
  if (!rows.length) return map;
  const rpc = write ? 'import_property_batch' as const : 'import_address_lookup' as const;
  let wrote = false;
  try {
    for (let i = 0; i < rows.length; i += IMPORT_PROPERTY_BATCH) {
      const slice = rows.slice(i, i + IMPORT_PROPERTY_BATCH);
      const payload = slice.map(({ i: rowIndex, r, mode }) => {
        const place = normalizePlace({ city: r.city, state: r.st, zip: r.zip });
        return {
          i: rowIndex,
          line1: r.addr,
          city: place.city ?? '',
          state: place.state ?? '',
          zip: place.zip ?? '',
          mode,
          ...propertyImportFields(r),
        };
      });
      const { data, error } = await sb.rpc(rpc, { p_workspace: workspaceId, p_rows: payload as Json });
      if (error || !Array.isArray(data)) return write && wrote ? map : null;
      const hits = data as { i?: number; property_id?: number | null; address_key?: string | null }[];
      for (const h of hits) {
        if (h.i == null || !Number.isFinite(Number(h.i))) continue;
        map.set(Number(h.i), { propertyId: h.property_id ?? null, addressKey: h.address_key ?? null });
      }
      wrote = write;
    }
    return map;
  } catch {
    return wrote ? map : null;
  }
}

/** What a record is matched on (address is the raw line; the database turns it into address_key). */
const keysOf = (kind: RecordKind, rec: AnyRecord): Omit<Keys, 'address'> => ({
  name: rec.name, phone: rec.phone, email: rec.email,
  sourceId: kind === 'vendors' ? null : (rec as ImportRecord | BuyerImportRecord).source_id,
});

// ---- duplicate review -----------------------------------------------------------

/**
 * Every row of a table, 1000 at a time (PostgREST caps a single read). A page
 * that fails throws: a short list would let the import create records CLOZR
 * already has.
 */
async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(`Could not read what CLOZR already has: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/**
 * The rows the duplicate check compares against: one import_existing_keys
 * call (migration 303, the same columns in id order), else, on a database
 * without it or a refused call, the table a page at a time as before (which
 * throws if a page fails, rather than answer with part of the table).
 */
async function existingRows<T>(
  kind: RecordKind, workspaceId: number, page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const { data, error } = await supabase!.rpc('import_existing_keys' as never, { p_ws: workspaceId, p_kind: kind } as never, { get: true });
  return !error && Array.isArray(data) ? (data as T[]) : readAll(page);
}

export type Review = { matches: Match[]; existing: Record<number, Existing>; addressKeys: (string | null)[] };

/**
 * Classify every row against the file and against CLOZR. Reads only. Sellers
 * also match on the property's address_key, asked of the database so its idea
 * of "the same address" is the one used.
 */
export async function reviewDuplicates(
  kind: RecordKind, workspaceId: number, records: AnyRecord[], onProgress?: (done: number, total: number) => void,
): Promise<Review> {
  if (!supabase) return { matches: classify(records.map((r) => ({ ...keysOf(kind, r), address: null })), []), existing: {}, addressKeys: records.map(() => null) };
  const sb = supabase;
  let existing: Existing[] = [];
  const addressKeys: (string | null)[] = records.map(() => null);

  if (kind === 'sellers') {
    const wanted = records.flatMap((r, i) => {
      const x = r as ImportRecord;
      return x.addr ? [{ i, r: x, mode: 'fill' as const }] : [];
    });
    // Both only read, so they go at once.
    const [sellers, looked] = await Promise.all([
      existingRows(kind, workspaceId, (a, b) => sb.from('sellers').select('id, name, phone, email, property_id, property_address, source_id, lead_stage').eq('workspace_id', workspaceId).order('id').range(a, b)),
      resolveImportProperties(workspaceId, wanted, false),
    ]);
    if (looked) {
      const keyOf = new Map<number, string>();
      looked.forEach((h) => { if (h.propertyId != null && h.addressKey) keyOf.set(h.propertyId, h.addressKey); });
      existing = sellers.map((s) => ({
        id: s.id, name: s.name, phone: s.phone, email: s.email, sourceId: s.source_id,
        address: s.property_id ? keyOf.get(s.property_id) ?? null : null, propertyId: s.property_id,
        show: [s.name, s.phone ?? '', s.email ?? '', s.property_address ?? '', s.lead_stage],
      }));
      records.forEach((_, i) => { addressKeys[i] = looked.get(i)?.addressKey ?? null; });
      onProgress?.(wanted.length, wanted.length);
    } else {
      const props = await readAll((a, b) => sb.from('properties').select('id, address_key').eq('workspace_id', workspaceId).order('id').range(a, b));
      const keyOf = new Map(props.map((p) => [p.id, p.address_key]));
      existing = sellers.map((s) => ({
        id: s.id, name: s.name, phone: s.phone, email: s.email, sourceId: s.source_id,
        address: s.property_id ? keyOf.get(s.property_id) ?? null : null, propertyId: s.property_id,
        show: [s.name, s.phone ?? '', s.email ?? '', s.property_address ?? '', s.lead_stage],
      }));
      // address_key for each distinct incoming address, a few at a time.
      const lines = records.map((r) => {
        const x = r as ImportRecord;
        return x.addr ? [x.addr, x.city ?? '', x.st ?? '', x.zip ?? ''] : null;
      });
      const distinct = [...new Set(lines.filter(Boolean).map((l) => JSON.stringify(l)))];
      const got = new Map<string, string | null>();
      for (let i = 0; i < distinct.length; i += 20) {
        await Promise.all(distinct.slice(i, i + 20).map(async (k) => {
          const [line1, city, st, zip] = JSON.parse(k) as string[];
          const { data, error } = await sb.rpc('address_key', { p_line1: line1, p_city: city, p_state: st, p_zip: zip });
          // No key would read as "no house on file" and let the import add the address again.
          if (error) throw new Error(`Could not match addresses: ${error.message}`);
          got.set(k, (data as string | null) ?? null);
        }));
        onProgress?.(Math.min(i + 20, distinct.length), distinct.length);
      }
      lines.forEach((l, i) => { addressKeys[i] = l ? got.get(JSON.stringify(l)) ?? null : null; });
    }
  } else if (kind === 'buyers') {
    const rows = await existingRows(kind, workspaceId, (a, b) => sb.from('buyers').select('id, name, company, phone, email, source_id, status').eq('workspace_id', workspaceId).order('id').range(a, b));
    existing = rows.map((b) => ({ id: b.id, name: b.name, phone: b.phone, email: b.email, sourceId: b.source_id, address: null, show: [b.name, b.phone ?? '', b.email ?? '', b.company ?? '', b.status] }));
  } else {
    const rows = await existingRows(kind, workspaceId, (a, b) => sb.from('vendors').select('id, business_name, contact_name, phone, email, service_type').eq('workspace_id', workspaceId).order('id').range(a, b));
    existing = rows.map((v) => ({ id: v.id, name: v.business_name, phone: v.phone, email: v.email, sourceId: null, address: null, show: [v.business_name, v.phone ?? '', v.email ?? '', v.contact_name ?? '', v.service_type ?? ''] }));
  }

  const matches = classify(records.map((r, i) => ({ ...keysOf(kind, r), address: addressKeys[i] })), existing);
  const byId: Record<number, Existing> = {};
  // A map, not a scan of every existing row per match (a big workspace holds 100,000+ buyers).
  const known = new Map<number, Existing>();
  for (const e of existing) if (!known.has(e.id)) known.set(e.id, e);
  for (const m of matches) if (m.kind === 'existing' || m.kind === 'conflict') byId[m.id] = known.get(m.id)!;
  return { matches, existing: byId, addressKeys };
}

// ---- writing ----------------------------------------------------------------

export type ImportOptions = {
  label: string;
  /** Teammate user ids. None: unassigned. One: all to them. Several: round-robin. Sellers only — buyers and vendors have no owner. */
  assignees: string[];
  /** Sellers: lead stage for the rows written; null keeps the file's stage (or New Lead). */
  stage: string | null;
  /** Buyers: the stage (buyers.status) new buyers start in — and updated ones too, with applyToUpdated. */
  buyerStatus: string;
  tags: string[];
  /** Sellers: an action plan to enrol new sellers in. */
  planId: number | null;
  /** Also apply assignment, stage, tags and plan to records that were updated, not only created. */
  applyToUpdated: boolean;
  /**
   * Sellers: who underwrites each lead (sellers.underwriter_id, migration 121).
   * 'same' follows the assigned rep row by row (so it rotates with them), a user
   * id puts everyone on that teammate, null leaves it empty.
   */
  underwriter?: 'same' | string | null;
  /** Vendors: one service type for every row, over the file's own column. */
  vendorType?: string | null;
};

export type ImportResult = { created: number; updated: number; cosellers: number; skipped: number; errors: string[] };
export type ReportRow = { row: number; name: string; action: string; result: 'created' | 'updated' | 'co-seller' | 'skipped' | 'error'; id: number | null; detail: string };

const blankish = (v: unknown) => v == null || v === '' || (Array.isArray(v) && !v.length);

const attachPhotos = (workspaceId: number, dealId: number, urls: string[]) => attachPhotoLinks(workspaceId, dealId, urls);
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/**
 * A row that adds to or overrides a seller CLOZR already has carries its deal
 * numbers too (lib/import-dedupe planImportDeal): the seller's open deal takes
 * the row's ARV, rehab and offer by the same fill / overwrite rule, a seller
 * with no deal gets one, and photos land on the deal. Returns what happened,
 * for the report.
 */
async function dealForUpdatedSeller(
  workspaceId: number, sellerId: number, r: ImportRecord, mode: 'fill' | 'overwrite',
  make: { propertyId: number | null; ownerId: string | null; userId: string | null },
): Promise<string> {
  if (!supabase) return '';
  const { data: deals, error: readError } = await supabase.from('deals').select('id, stage, arv, rehab, offer_amount')
    .eq('workspace_id', workspaceId).eq('seller_id', sellerId).order('created_at', { ascending: false }).limit(50);
  // Unread deals would look like none and get the seller a second one.
  if (readError) throw new Error('deal: ' + readError.message);
  const plan = planImportDeal(r, (deals ?? []) as DealOnFile[], mode);
  if (plan.kind === 'none') return '';
  if (plan.kind === 'create') {
    const { data: deal, error } = await supabase.from('deals').insert({
      workspace_id: workspaceId, seller_id: sellerId, property_id: make.propertyId,
      stage: r.stage ?? 'New Lead', ...plan.fields,
      owner_id: make.ownerId ?? make.userId, created_by: make.userId, source: 'import',
    }).select('id').single();
    if (error) throw new Error('deal: ' + error.message);
    await attachPhotos(workspaceId, deal.id, plan.photos);
    return 'deal created';
  }
  if (plan.kind === 'update' && Object.keys(plan.patch).length) {
    const { error } = await supabase.from('deals').update({ ...plan.patch, updated_at: new Date().toISOString() })
      .eq('id', plan.dealId).eq('workspace_id', workspaceId);
    if (error) throw new Error('deal: ' + error.message);
  }
  await attachPhotos(workspaceId, plan.dealId, plan.photos);
  return plan.kind === 'closed' ? 'deal closed, numbers left as they were'
    : Object.keys(plan.patch).length ? 'deal ' + Object.keys(plan.patch).join(' ') : plan.photos.length ? 'deal photos' : '';
}

/**
 * Fold a duplicate row's values into the row it duplicates: blanks filled,
 * lists joined, bags merged key by key — and its phone and email, when they
 * differ from the first row's, become other numbers and emails, not lost.
 */
export function foldInto<T extends AnyRecord>(into: T, from: AnyRecord): T {
  const out = { ...into } as Record<string, unknown>;
  const f = from as Record<string, unknown>;
  for (const [k, v] of Object.entries(from)) {
    if (k === 'problem' || blankish(v)) continue;
    if (k === 'otherPhones' && Array.isArray(out[k])) {
      const have = out[k] as (FoundPhone | string)[];
      const keyOf = (p: FoundPhone | string) => { const x = typeof p === 'string' ? p : p.phone; return toE164(x) ?? x ?? ''; };
      out[k] = [...have, ...(v as (FoundPhone | string)[]).filter((p) => !have.some((h) => keyOf(h) === keyOf(p)))];
    } else if (Array.isArray(out[k]) && Array.isArray(v)) out[k] = uniq([...(out[k] as string[]), ...(v as string[])]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...(v as object), ...((out[k] as object | null) ?? {}) };
    else if (blankish(out[k]) || (k === 'name' && out[k] === '—')) out[k] = v;
  }
  const differs = (a: unknown, b: unknown, key: (x: string) => string | null) => typeof a === 'string' && typeof b === 'string' && a && b && key(a) !== key(b);
  if (Array.isArray(out.otherPhones) && differs(out.phone, f.phone, (x) => toE164(x) ?? x)) {
    const list = out.otherPhones as (FoundPhone | string)[];
    const has = list.some((p) => (toE164(typeof p === 'string' ? p : p.phone) ?? '') === toE164(f.phone as string));
    if (!has) out.otherPhones = [...list, typeof list[0] === 'string' || !('phoneDnc' in f) ? f.phone : { phone: f.phone as string, kind: (f.phoneKind as string | null) ?? null, dnc: !!f.phoneDnc }];
  }
  if (Array.isArray(out.otherEmails) && differs(out.email, f.email, (x) => x.toLowerCase())) {
    const list = out.otherEmails as string[];
    if (!list.some((e) => e.toLowerCase() === (f.email as string).toLowerCase())) out.otherEmails = [...list, f.email as string];
  }
  return out as T;
}

/**
 * Write the reviewed rows. Only rows whose action says so are touched; a
 * duplicate is never created. Rows go ten at a time with progress, and every
 * row ends up in the report, whatever happened to it.
 */
export async function runImport(
  kind: RecordKind, workspaceId: number, userId: string | null,
  records: AnyRecord[], review: Review, actions: (Action | null)[], opts: ImportOptions,
  onProgress?: (done: number) => void,
): Promise<{ result: ImportResult; report: ReportRow[] }> {
  const result: ImportResult = { created: 0, updated: 0, cosellers: 0, skipped: 0, errors: [] };
  const report: ReportRow[] = [];
  if (!supabase) { result.errors.push('Supabase is not configured.'); return { result, report }; }
  const sb = supabase;

  // Merges first: a row marked merge adds its values to the row it duplicates.
  const recs = records.slice();
  const rootOf = (i: number): number => { const m = review.matches[i]; return m.kind === 'file' && actions[i] === 'merge' ? rootOf(m.row) : i; };
  recs.forEach((r, i) => { const root = rootOf(i); if (root !== i) recs[root] = foldInto(recs[root], r); });

  // Round-robin is decided up front so parallel batches cannot reorder it.
  let turn = 0;
  const owner = (i: number): string | null => {
    const a = actions[i];
    const counts = a === 'create' || a === 'coseller' || ((a === 'fill' || a === 'overwrite') && opts.applyToUpdated);
    return counts && opts.assignees.length ? opts.assignees[turn++ % opts.assignees.length] : null;
  };
  const owners = recs.map((_, i) => (kind === 'sellers' && !recs[i].problem ? owner(i) : null));
  const underwriters = owners.map((o, i) => {
    if (kind !== 'sellers' || recs[i].problem || !opts.underwriter) return null;
    const a = actions[i];
    if (!(a === 'create' || a === 'coseller' || ((a === 'fill' || a === 'overwrite') && opts.applyToUpdated))) return null;
    return opts.underwriter === 'same' ? o : opts.underwriter;
  });

  const extraTags = uniq([...opts.tags, opts.label]);

  const propertyHits = kind === 'sellers'
    ? await resolveImportProperties(workspaceId, recs.flatMap((rec, i) => {
      const a = actions[i];
      const r = rec as ImportRecord;
      if (rec.problem || !a || a === 'skip' || a === 'merge' || !r.addr) return [];
      return [{ i, r, mode: (a === 'overwrite' ? 'overwrite' : 'fill') as 'fill' | 'overwrite' }];
    }), true)
    : null;

  async function payload(i: number, rec: AnyRecord): Promise<Record<string, unknown>> {
    if (kind === 'vendors') {
      const r = rec as VendorImportRecord;
      return { business_name: r.name, contact_name: r.contact_name, phone: phoneOut(r.phone), email: r.email, service_type: opts.vendorType || r.service_type, markets: r.markets,
        notes: [r.notes, importBlock(extraNoteLines(r))].filter(Boolean).join('\n') || null };
    }
    if (kind === 'buyers') {
      const r = rec as BuyerImportRecord;
      const phones = [phoneOut(r.phone), phoneOut(r.phone2)].filter(Boolean) as string[];
      const row = buyerRow({
        name: r.name, company: r.company, phone: phones[0] ?? null, email: r.email, website: r.website,
        buyer_type: r.buyer_type, entity_type: r.entity_type, preferred_channel: r.preferred_channel ?? undefined,
        ...(r.vip != null ? { vip: r.vip } : {}),
        ...(r.vetted != null ? { vetted: r.vetted } : {}),
        ...(r.blacklisted != null ? { blacklisted: r.blacklisted } : {}),
        ...(r.wants_calls != null ? { wants_calls: r.wants_calls } : {}),
        ...(r.wants_follow_ups != null ? { wants_follow_ups: r.wants_follow_ups } : {}),
        tags: uniq([...r.tags, ...extraTags]), source: 'import',
        notes: [r.notes, importBlock(extraNoteLines(r, phones.slice(1)))].filter(Boolean).join('\n') || null,
        criteria: normalizeBuyBox({
          location_prefs: r.markets.map((m) => ({ name: m, type: /^\d{5}$/.test(m) ? 'zip' : /^[A-Za-z]{2}$/.test(m) ? 'state' : 'city' })),
          strategies: r.strategies, property_types: r.property_types,
          restrictions: r.restrictions, requirements: r.requirements,
          price: { min: r.min_price, max: r.max_price },
          beds: { min: r.min_beds }, baths: { min: r.min_baths },
          sqft: { min: r.min_sqft, max: r.max_sqft },
          year_built: { min: r.min_year, max: r.max_year },
          lot_sqft: { min: r.min_lot, max: r.max_lot },
          timeline_days: r.timeline,
          economics: { funding: r.funding },
          notes: r.buy_box || '',
        }),
      });
      if (!row.buy_box && r.buy_box) row.buy_box = r.buy_box;
      return { ...row, source_id: r.source_id };
    }
    const r = rec as ImportRecord;
    const hit = propertyHits?.get(i);
    const propertyId = !r.addr ? null
      : hit ? hit.propertyId
      : await importProperty(workspaceId, r, actions[i] === 'overwrite' ? 'overwrite' : 'fill');
    return {
      name: r.name, phone: phoneOut(r.phone), email: r.email?.toLowerCase() ?? null,
      property_id: propertyId,
      property_address: r.addr ? [r.addr, r.city, [r.st, r.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : null,
      asking_price: r.asking, motivation: r.motivation, notes: r.notes,
      // A partner's sheet imported as people: the partner that sent the row is its source.
      source: r.source ?? r.submitter ?? opts.label, source_id: r.source_id,
      tags: uniq([...r.tags, ...extraTags]),
      lead_stage: opts.stage ?? r.stage ?? 'New Lead',
      assigned_to: owners[i],
      // Only when chosen, so a database without migration 121 still imports.
      ...(underwriters[i] ? { underwriter_id: underwriters[i] } : {}),
      // Mailing address, owner 2, other emails, extra columns (migration 134): only those the row has.
      ...sellerImportColumns(r),
    };
  }

  const entity = kind === 'sellers' ? 'seller' : kind === 'buyers' ? 'buyer' : 'vendor';
  const table = kind;

  /** logActivity's row for this import's line on a record. */
  const line = (id: number, title: string, body: string) => ({
    workspace_id: workspaceId, entity_type: entity, entity_id: id, kind: entity === 'seller' ? 'lead' : entity, title, body, actor_id: userId,
  });
  /**
   * What written rows still owe, sent together instead of per row: new sellers'
   * plan enrolment (enrollSellersInPlan, the same rows enrollInPlan wrote) and
   * then each row's activity line in one insert, so a record still reads
   * phones and deal, plan started, then Imported. Errors are ignored, as the
   * per-row writes ignored them.
   */
  const owed: { id: number; enroll: boolean; line: ReturnType<typeof line> }[] = [];
  const settle = async () => {
    const take = owed.splice(0);
    if (!take.length) return;
    const enroll = take.filter((o) => o.enroll).map((o) => String(o.id));
    if (opts.planId && enroll.length) await enrollSellersInPlan(workspaceId, String(opts.planId), enroll, userId).catch(() => null);
    await sb.from('activity').insert(take.map((o) => o.line)).then(() => undefined, () => undefined);
  };

  /**
   * Every number of a seller row goes on their other numbers (seller_phones)
   * in file order, with its type and DNC flag — the row's own main number too
   * when the seller already has a different one — and the report says so.
   */
  const keepPhones = async (id: number, primary: string | null | undefined, rec: AnyRecord): Promise<string> => {
    if (kind !== 'sellers') return '';
    const r = rec as ImportRecord;
    const found: FoundPhone[] = [...(r.phone ? [{ phone: r.phone, kind: r.phoneKind, dnc: r.phoneDnc }] : []), ...r.otherPhones];
    if (!found.length) return '';
    const k = await keepImportPhones(workspaceId, id, primary, found, 'import');
    if (!k.ok) return `other phones not kept (${k.message})`;
    return [k.added ? `${plural(k.added, 'other phone')} kept` : '', k.flagged ? `${k.flagged} marked DNC` : ''].filter(Boolean).join(' · ');
  };

  /** A seller write, again without the migration 134 columns (their values in the notes) when this database does not have them yet. */
  async function writeSeller<R>(row: Record<string, unknown>, go: (row: Record<string, unknown>) => PromiseLike<{ data: R; error: { message: string; code?: string } | null }>) {
    const res = await go(row);
    if (kind !== 'sellers' || !res.error || !isMissingColumn(res.error, SELLER_IMPORT_COLUMNS)) return res;
    return go(withoutImportColumns(row));
  }

  async function one(i: number) {
    const rec = recs[i];
    const m = review.matches[i];
    const a = actions[i];
    const base = { row: i + 1, name: rec.name };
    if (rec.problem || !a || a === 'skip' || a === 'merge') {
      result.skipped++;
      report.push({ ...base, action: a ?? 'unresolved', result: 'skipped', id: m.kind === 'existing' || m.kind === 'conflict' ? m.id : null,
        detail: rec.problem ?? (a === 'merge' && m.kind === 'file' ? `merged into row ${m.row + 1}` : m.kind === 'new' ? '' : m.kind === 'file' ? `duplicate of row ${m.row + 1} (${m.by})` : m.kind === 'existing' ? `already in CLOZR (${m.by})` : 'different seller on an existing property') });
      return;
    }
    try {
      const row = await payload(i, rec);
      if (a === 'create' || a === 'coseller') {
        const insert: Record<string, unknown> = { workspace_id: workspaceId, created_by: userId, ...row };
        if (kind === 'buyers') insert.status = opts.buyerStatus;
        if (kind === 'sellers') {
          const r = rec as ImportRecord;
          if (r.created) insert.created_at = r.created;
          if (a === 'coseller' && m.kind === 'conflict') {
            insert.property_id = m.propertyId ?? insert.property_id;
            insert.notes = ['Co-seller on an existing property (import).', r.notes].filter(Boolean).join('\n');
          }
        }
        const { data, error } = await writeSeller(insert, (x) => sb.from(table as 'sellers').insert(x as never).select('id').single());
        if (error || !data) throw new Error(error?.message ?? 'not saved');
        const id = data.id;
        const second = await keepPhones(id, row.phone as string | null, rec);
        if (kind === 'sellers') {
          const r = rec as ImportRecord;
          if (a === 'create' && (r.arv || r.rehab || r.offer || r.photos.length)) {
            const { data: deal } = await sb.from('deals').insert({
              workspace_id: workspaceId, seller_id: id, property_id: row.property_id as number | null,
              stage: r.stage ?? 'New Lead', arv: r.arv, rehab: r.rehab, offer_amount: r.offer,
              owner_id: owners[i] ?? userId, created_by: userId, source: 'import',
            }).select('id').single();
            if (deal && r.photos.length) await attachPhotos(workspaceId, deal.id, r.photos);
          }
        }
        // The plan enrolment (a new seller) and then the Imported line: settle() writes them for several rows at once.
        owed.push({ id, enroll: kind === 'sellers' && !!opts.planId, line: line(id, 'Imported', opts.label) });
        if (a === 'coseller') result.cosellers++; else result.created++;
        report.push({ ...base, action: a, result: a === 'coseller' ? 'co-seller' : 'created', id,
          detail: [owners[i] ? 'assigned' : '', underwriters[i] ? 'underwriter set' : '', second].filter(Boolean).join(' · ') });
        return;
      }
      // fill / overwrite an existing record.
      const id = (m as { id: number }).id;
      const { data: cur, error: curError } = await sb.from(table as 'sellers').select('*').eq('id', id).single();
      // Without the record as it is, fill and override would merge against nothing and overwrite its tags and notes.
      if (curError || !cur) throw new Error(!curError || curError.code === 'PGRST116' ? 'not found in CLOZR' : curError.message);
      const incoming = { ...row };
      if (!opts.applyToUpdated) { delete incoming.assigned_to; delete incoming.underwriter_id; }
      if (!opts.applyToUpdated || !opts.stage) delete incoming.lead_stage;
      // The import's own tags (its label, the tags typed above) only with "Also apply"; the row's tags always add.
      if (kind !== 'vendors' && !opts.applyToUpdated) incoming.tags = (rec as ImportRecord | BuyerImportRecord).tags;
      if (kind === 'buyers' && a !== 'overwrite') delete incoming.criteria; // fill does not blend a typed-in buy box; overwrite replaces it
      // Tags are added to and notes appended in both modes (mergePatch): Override never drops what a person wrote.
      const mode = a === 'overwrite' ? 'overwrite' : 'fill';
      const merge = (x: Record<string, unknown>) => mergePatch((cur ?? {}) as Record<string, unknown>, x, mode,
        { lists: ['tags', 'other_emails'], append: ['notes'], objects: ['import_extra'] });
      let patch = merge(incoming);
      if (kind === 'buyers') { delete patch.status; if (opts.applyToUpdated) patch.status = opts.buyerStatus; }
      if (Object.keys(patch).length) {
        const stamp = () => new Date().toISOString();
        let { error } = await sb.from(table as 'sellers').update({ ...patch, updated_at: stamp() } as never).eq('id', id);
        if (error && kind === 'sellers' && isMissingColumn(error, SELLER_IMPORT_COLUMNS)) {
          // An older database: what migration 134 would hold goes into the notes instead.
          patch = merge(withoutImportColumns(incoming));
          ({ error } = await sb.from(table as 'sellers').update({ ...patch, updated_at: stamp() } as never).eq('id', id));
        }
        if (error) throw new Error(error.message);
      }
      const second = await keepPhones(id, (patch.phone as string | null | undefined) ?? (cur as { phone?: string | null } | null)?.phone, rec);
      if (kind === 'sellers' && opts.planId && opts.applyToUpdated) await enrollInPlan(workspaceId, String(opts.planId), String(id), userId);
      // The seller's property after this row: Override can move them to the file's address (and a seller without one gets it); their open deals go too.
      const wasOn = (cur as { property_id?: number | null } | null)?.property_id ?? null;
      const nowOn = 'property_id' in patch ? (patch.property_id as number | null) : wasOn;
      if (kind === 'sellers' && nowOn && nowOn !== wasOn) await moveOpenDeals(workspaceId, [id], wasOn, nowOn);
      // The row's deal numbers and photos follow the same choice onto the seller's open deal (links already there are skipped).
      const dealNote = kind === 'sellers'
        ? await dealForUpdatedSeller(workspaceId, id, rec as ImportRecord, mode, { propertyId: nowOn, ownerId: owners[i], userId })
        : '';
      const changed = [Object.keys(patch).join(', '), dealNote].filter(Boolean).join('; ');
      owed.push({ id, enroll: false, line: line(id, 'Updated by import', `${opts.label}: ${changed || 'nothing new'}`) });
      result.updated++;
      report.push({ ...base, action: a, result: 'updated', id, detail: [Object.keys(patch).join(' '), dealNote, second].filter(Boolean).join(' · ') || 'nothing new' });
    } catch (e) {
      result.errors.push(`${rec.name}: ${(e as Error).message}`);
      report.push({ ...base, action: a, result: 'error', id: null, detail: (e as Error).message });
    }
  }

  // Ten rows at a time as a rolling pool (a slow row no longer holds the other
  // nine), progress every ten rows as before, and what the rows owe settled
  // every ten rows and at the end.
  let done = 0;
  await eachLimited(recs.map((_, i) => i), 10, async (i) => {
    await one(i);
    if (owed.length >= 10) await settle();
    done++;
    if (done % 10 === 0 || done === recs.length) onProgress?.(done);
  });
  await settle();
  report.sort((x, y) => x.row - y.row);
  const runEntity = kind === 'sellers' ? 'seller' : kind === 'buyers' ? 'buyer' : 'vendor';
  const ok = result.created + result.updated + result.cosellers;
  await logRun(workspaceId, {
    kind: 'import', entity: runEntity, label: opts.label || 'Import', total: recs.length, succeeded: ok, failed: result.errors.length, credits: 0,
    detail: { created: result.created, updated: result.updated, cosellers: result.cosellers, skipped: result.skipped, ...(kind === 'buyers' ? { stage: opts.buyerStatus } : opts.stage ? { stage: opts.stage } : {}), ...(result.errors.length ? { errors: result.errors.slice(0, 20) } : {}) },
  });
  await notifyUser(workspaceId, userId, {
    category: 'Import', title: `Import finished · ${opts.label || kind}`,
    body: `${result.created} created · ${result.updated} updated${result.skipped ? ` · ${result.skipped} skipped` : ''}${result.errors.length ? ` · ${result.errors.length} failed` : ''}`,
  });
  return { result, report };
}

/** The per-row report as CSV, for the person to keep. */
export function importReportCsv(report: ReportRow[]): string {
  const q = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [['Row', 'Name', 'Action', 'Result', 'CLOZR id', 'Detail'], ...report.map((r) => [r.row, r.name, r.action, r.result, r.id ?? '', r.detail])]
    .map((r) => r.map(q).join(',')).join('\n');
}

/** When each source label was last imported, newest first, from the activity the import logs. */
export async function lastImports(workspaceId: number): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.from('activity').select('body, created_at').eq('workspace_id', workspaceId)
    .eq('title', 'Imported').order('created_at', { ascending: false }).limit(2000);
  const out: Record<string, string> = {};
  for (const a of data ?? []) if (a.body && !(a.body in out)) out[a.body] = a.created_at;
  return out;
}

// ---- AI mapping -------------------------------------------------------------

export type AiMapResult =
  | { ok: true; mapping: Mapping; reasons: Record<number, string>; confidence: Confidences }
  | { ok: false; message: string };

/**
 * Ask Claude to map the columns, for a file the local matcher does not
 * recognise. Goes through the map-columns edge function, which holds the API
 * key; the result is a suggestion the person still reviews before importing.
 */
export async function aiMap(table: Table, kind: RecordKind = 'sellers'): Promise<AiMapResult> {
  const targets = TARGETS_BY_KIND[kind];
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('map-columns', {
    body: {
      headers: table.headers,
      samples: table.rows.slice(0, 8),
      targets: targets.map((t) => ({ key: t.key, label: t.label })),
      kind,
    },
  });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as { ok?: boolean; mapping?: Record<string, string>; reasons?: Record<string, string>; confidence?: Record<string, string>; error?: string };
  if (!r?.ok || !r.mapping) return { ok: false, message: r?.error ?? 'No mapping came back.' };
  const mapping: Mapping = {};
  const valid = new Set(targets.map((t) => t.key));
  // "No home" from the model is kept as extra info here; nothing is dropped unless a person picks Don't import.
  for (const [i, t] of Object.entries(r.mapping)) mapping[Number(i)] = (valid.has(t as Target) && t !== 'skip' ? t : 'extra') as Target;
  const reasons: Record<number, string> = {};
  for (const [i, why] of Object.entries(r.reasons ?? {})) reasons[Number(i)] = why;
  // An older deploy of the function sends no confidence; its guesses read as medium.
  const confidence: Confidences = {};
  for (const i of Object.keys(mapping)) {
    const c = r.confidence?.[i];
    confidence[Number(i)] = c === 'high' || c === 'low' ? c : 'medium';
  }
  return { ok: true, mapping, reasons, confidence };
}
