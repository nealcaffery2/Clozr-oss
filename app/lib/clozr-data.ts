// CLOZR mock data — one entity graph, ported from the Claude Design prototype.
// Replace with API data later; shapes mirror lib/database.types.ts (sellers, buyers, vendors)
// plus deals / comms / tasks / offers / transactions.

import { tcChecklists } from '../supabase/functions/_shared/tc-checklists';

const IMG = {
  a:'https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=800&q=70&auto=format&fit=crop',
  b:'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=800&q=70&auto=format&fit=crop',
  c:'https://images.unsplash.com/photo-1572120360610-d971b9d7767c?w=800&q=70&auto=format&fit=crop',
  d:'https://images.unsplash.com/photo-1605276374104-dee2a0ed3cd6?w=800&q=70&auto=format&fit=crop',
  e:'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=800&q=70&auto=format&fit=crop',
  f:'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800&q=70&auto=format&fit=crop',
  g:'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=70&auto=format&fit=crop',
  h:'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=800&q=70&auto=format&fit=crop',
  i:'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=800&q=70&auto=format&fit=crop',
  j:'https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?w=800&q=70&auto=format&fit=crop',
  k:'https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=800&q=70&auto=format&fit=crop',
  l:'https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=800&q=70&auto=format&fit=crop',
  m:'https://images.unsplash.com/photo-1580587771525-78b9dba3b914?w=800&q=70&auto=format&fit=crop',
  n:'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=800&q=70&auto=format&fit=crop',
  o:'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=800&q=70&auto=format&fit=crop',
  kitchen:'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&q=70&auto=format&fit=crop',
  bath:'https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=800&q=70&auto=format&fit=crop',
  living:'https://images.unsplash.com/photo-1484154218962-a197022b5858?w=800&q=70&auto=format&fit=crop',
  bed:'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?w=800&q=70&auto=format&fit=crop',
};

const team = {
  sam:{id:'sam',name:'Sam Carter',initials:'SC',role:'Owner',dept:'Acquisitions',lb:{calls:212,sms:140,emails:22,conversations:19}},
  diego:{id:'diego',name:'Diego Ortiz',initials:'DO',role:'Acquisitions',dept:'Acquisitions',lb:{calls:611,sms:388,emails:64,conversations:52}},
  taylor:{id:'taylor',name:'Taylor Reed',initials:'TR',role:'Acquisitions',dept:'Acquisitions',lb:{calls:684,sms:412,emails:71,conversations:58}},
  morgan:{id:'morgan',name:'Morgan Lane',initials:'ML',role:'Dispositions',dept:'Dispo',lb:{calls:402,sms:610,emails:188,conversations:44}},
  alex:{id:'alex',name:'Alex Cole',initials:'AC',role:'Dispositions',dept:'Dispo',lb:{calls:366,sms:520,emails:141,conversations:37}},
  avery:{id:'avery',name:'Avery Nguyen',initials:'AN',role:'Dispositions',dept:'Dispo',lb:{calls:355,sms:470,emails:120,conversations:31}},
  casey:{id:'casey',name:'Casey Park',initials:'CP',role:'Transaction Coordinator',dept:'TC'},
};

const STAGES = ['New Lead','Contacted','Qualified','Appointment','Offer Sent','Negotiation','Under Contract','Dispo','Assigned','Closing','Closed','Lost'];

const people = [
  {id:'p1',name:'Kara Mitchell',stage:'Qualified',score:92,assigned:'taylor',source:'Google PPC',phone:'(210) 555-0136',email:'kara.mitchell@gmail.com',lastComm:'Call · 42m ago',lastCommTs:42,nextTask:'Call seller · 1:30 PM',offer:null,created:'Aug 22',tags:['Motivated','Relocation','Inherited'],market:'San Antonio',
    motivation:'Relocating for work',timeline:'Before Sept 30',condition:'Dated · C4',occupancy:'Owner occupied',mortgage:'$118,400 · Wells Fargo',asking:'$235,000',desiredClose:'30 days',decisionMakers:'Kara + brother (co-heir)',
    property:{addr:'123 Oakview Drive',city:'San Antonio',st:'TX',zip:'78254',beds:4,baths:2,sqft:2140,year:1996,lot:'0.21 ac',type:'SFR',img:IMG.a,apn:'04812-000-0140'}},
  {id:'p2',name:'Ronald Moore',stage:'Offer Sent',score:88,assigned:'diego',source:'Direct Mail',phone:'(713) 555-0192',email:'rmoore58@yahoo.com',lastComm:'SMS · 3h ago',lastCommTs:180,nextTask:'Follow up offer · Today',offer:'$186,000',created:'Aug 14',tags:['Tired Landlord'],market:'Houston',
    motivation:'Tired landlord',timeline:'60 days',condition:'Fair · C4',occupancy:'Tenant',mortgage:'Free & clear',asking:'$205,000',desiredClose:'Flexible',decisionMakers:'Ronald',
    property:{addr:'1803 Cypress Lane',city:'Houston',st:'TX',zip:'77084',beds:3,baths:2,sqft:1620,year:1988,lot:'0.18 ac',type:'SFR',img:IMG.b,apn:'1120340000012'}},
  {id:'p3',name:'John Smith',stage:'New Lead',score:71,assigned:null,source:'Facebook PPC',phone:'(817) 555-0117',email:'jsmith.tx@gmail.com',lastComm:'—',lastCommTs:null,nextTask:'First call · Now',offer:null,created:'Today 8:51 AM',tags:[],market:'DFW',
    motivation:'Behind on payments',timeline:'ASAP',condition:'Unknown',occupancy:'Owner occupied',mortgage:'$142,000 · Mr. Cooper',asking:'—',desiredClose:'—',decisionMakers:'John + spouse',
    property:{addr:'4410 Bluebonnet Trail',city:'Fort Worth',st:'TX',zip:'76133',beds:3,baths:2,sqft:1480,year:1979,lot:'0.19 ac',type:'SFR',img:IMG.c,apn:'02277-118'}},
  {id:'p4',name:'Derek Ross',stage:'Negotiation',score:84,assigned:'taylor',source:'Website',phone:'(469) 555-0181',email:'derek.ross@outlook.com',lastComm:'Email · Yesterday',lastCommTs:1400,nextTask:'Send repair breakdown · Tomorrow',offer:'$198,500',created:'Aug 9',tags:['Divorce'],market:'DFW',
    motivation:'Divorce settlement',timeline:'45 days',condition:'Good · C3',occupancy:'Vacant',mortgage:'$61,000 · Chase',asking:'$215,000',desiredClose:'Sept 20',decisionMakers:'Derek + attorney',
    property:{addr:'81 Meadow Lane',city:'Dallas',st:'TX',zip:'75217',beds:3,baths:2,sqft:1710,year:1992,lot:'0.16 ac',type:'SFR',img:IMG.d,apn:'00000551000A0100'}},
  {id:'p5',name:'Andrea Lopez',stage:'Under Contract',score:90,assigned:'diego',source:'Inbound Call',phone:'(210) 555-0164',email:'alopez@icloud.com',lastComm:'Call · Today 8:18',lastCommTs:95,nextTask:'Inspection access · Aug 26',offer:'$265,000',created:'Jul 30',tags:['Probate'],market:'San Antonio',
    motivation:'Probate',timeline:'Closing scheduled',condition:'Fair · C4',occupancy:'Vacant',mortgage:'Free & clear',asking:'$280,000',desiredClose:'Sept 12',decisionMakers:'Andrea (executor)',
    property:{addr:'44 Benton Court',city:'San Antonio',st:'TX',zip:'78230',beds:4,baths:3,sqft:2380,year:2001,lot:'0.24 ac',type:'SFR',img:IMG.e,apn:'15377-004-0120'}},
  {id:'p6',name:'Patricia Hale',stage:'Dispo',score:95,assigned:'diego',source:'Google PPC',phone:'(214) 555-0143',email:'p.hale@gmail.com',lastComm:'SMS · Yesterday',lastCommTs:1200,nextTask:'Confirm walkthrough · Tomorrow',offer:'$214,000',created:'Jul 18',tags:['Inherited'],market:'DFW',
    motivation:'Inherited property',timeline:'Closing Sept 22',condition:'Heavy · C5',occupancy:'Vacant',mortgage:'Free & clear',asking:'$225,000',desiredClose:'Sept 22',decisionMakers:'Patricia',
    property:{addr:'2207 Willow Street',city:'Dallas',st:'TX',zip:'75211',beds:3,baths:2,sqft:1850,year:1972,lot:'0.22 ac',type:'SFR',img:IMG.f,apn:'00000447112000000'}},
  {id:'p7',name:'Gary Whitfield',stage:'Offer Sent',score:77,assigned:'taylor',source:'Cold Call',phone:'(281) 555-0170',email:'gwhitfield@aol.com',lastComm:'Voicemail · 2d ago',lastCommTs:2900,nextTask:'Offer expires Tue',offer:'$188,000',created:'Aug 3',tags:[],market:'Houston',
    motivation:'Downsizing',timeline:'90 days',condition:'Good · C3',occupancy:'Owner occupied',mortgage:'$32,000',asking:'$210,000',desiredClose:'Oct',decisionMakers:'Gary + wife',
    property:{addr:'615 Lake Ridge Drive',city:'Houston',st:'TX',zip:'77345',beds:3,baths:2,sqft:1760,year:1994,lot:'0.20 ac',type:'SFR',img:IMG.g,apn:'1160880010004'}},
  {id:'p8',name:'Linda Barnes',stage:'Closing',score:93,assigned:'diego',source:'Referral',phone:'(817) 555-0155',email:'lbarnes@gmail.com',lastComm:'Email · Today 7:02',lastCommTs:170,nextTask:'Final walkthrough · Thu',offer:'$176,000',created:'Jul 2',tags:['Repeat'],market:'DFW',
    motivation:'Estate sale',timeline:'Closing Friday',condition:'Fair · C4',occupancy:'Vacant',mortgage:'Free & clear',asking:'$180,000',desiredClose:'Sept 6',decisionMakers:'Linda',
    property:{addr:'388 Pine Terrace',city:'Fort Worth',st:'TX',zip:'76114',beds:3,baths:1,sqft:1290,year:1961,lot:'0.17 ac',type:'SFR',img:IMG.h,apn:'01922-120'}},
  {id:'p9',name:'Miguel Santos',stage:'Dispo',score:86,assigned:'taylor',source:'Direct Mail',phone:'(210) 555-0128',email:'msantos78@gmail.com',lastComm:'Call · Yesterday',lastCommTs:1500,nextTask:'2 offers to review',offer:'$200,000',created:'Jul 21',tags:['Vacant'],market:'San Antonio',
    motivation:'Vacant property, taxes due',timeline:'Closing Sept 18',condition:'Heavy · C5',occupancy:'Vacant',mortgage:'Free & clear',asking:'$215,000',desiredClose:'Sept 18',decisionMakers:'Miguel',
    property:{addr:'1520 Easton Avenue',city:'San Antonio',st:'TX',zip:'78210',beds:3,baths:2,sqft:1540,year:1968,lot:'0.15 ac',type:'SFR',img:IMG.i,apn:'05122-009-0010'}},
  {id:'p10',name:'Marvin Cole',stage:'Closing',score:81,assigned:'taylor',source:'Zapier Webhook',phone:'(512) 555-0109',email:'marvin.cole@gmail.com',lastComm:'SMS · Today 9:10',lastCommTs:40,nextTask:'Title cleared · Fund Friday',offer:'$185,000',created:'Jun 28',tags:[],market:'Austin',
    motivation:'Job relocation',timeline:'Closing Friday',condition:'Good · C3',occupancy:'Vacant',mortgage:'$88,000',asking:'$199,000',desiredClose:'Sept 6',decisionMakers:'Marvin',
    property:{addr:'910 Cedar Way',city:'Austin',st:'TX',zip:'78745',beds:3,baths:2,sqft:1420,year:1984,lot:'0.18 ac',type:'SFR',img:IMG.j,apn:'04150908130000'}},
  {id:'p11',name:'Teresa Vance',stage:'Contacted',score:64,assigned:'diego',source:'Facebook PPC',phone:'(972) 555-0133',email:'tvance@gmail.com',lastComm:'SMS · 5h ago',lastCommTs:300,nextTask:'Callback · 4:00 PM',offer:null,created:'Aug 28',tags:[],market:'DFW',
    motivation:'Exploring options',timeline:'6 months',condition:'Good · C3',occupancy:'Owner occupied',mortgage:'$155,000',asking:'$260,000',desiredClose:'—',decisionMakers:'Teresa + husband',
    property:{addr:'7302 Sagebrush Ct',city:'Plano',st:'TX',zip:'75074',beds:4,baths:2,sqft:2050,year:1998,lot:'0.20 ac',type:'SFR',img:IMG.k,apn:'R-2233-001'}},
  {id:'p12',name:'Harold Kim',stage:'Appointment',score:79,assigned:'taylor',source:'Google PPC',phone:'(713) 555-0188',email:'hkim@gmail.com',lastComm:'Call · Yesterday',lastCommTs:1300,nextTask:'Walkthrough · Sat 10:00',offer:null,created:'Aug 26',tags:['Foreclosure'],market:'Houston',
    motivation:'Pre-foreclosure',timeline:'30 days',condition:'Fair · C4',occupancy:'Owner occupied',mortgage:'$171,000 · behind 4 mo',asking:'$230,000',desiredClose:'Sept 30',decisionMakers:'Harold',
    property:{addr:'9021 Brookhollow Dr',city:'Houston',st:'TX',zip:'77042',beds:3,baths:2,sqft:1690,year:1983,lot:'0.19 ac',type:'SFR',img:IMG.l,apn:'0990120000041'}},
  {id:'p13',name:'Denise Carter',stage:'Contacted',score:58,assigned:'diego',source:'Direct Mail',phone:'(210) 555-0177',email:'—',lastComm:'Call · 3d ago',lastCommTs:4300,nextTask:'Long-term follow-up · Oct 1',offer:null,created:'Aug 12',tags:['Long-term'],market:'San Antonio',
    motivation:'Not urgent',timeline:'12 months',condition:'Good · C3',occupancy:'Owner occupied',mortgage:'$92,000',asking:'$275,000',desiredClose:'—',decisionMakers:'Denise',
    property:{addr:'318 Harvest Moon',city:'San Antonio',st:'TX',zip:'78253',beds:4,baths:3,sqft:2410,year:2005,lot:'0.23 ac',type:'SFR',img:IMG.m,apn:'04890-201-0030'}},
  {id:'p14',name:'Bruce Tanner',stage:'Lost',score:31,assigned:'taylor',source:'Cold Call',phone:'(214) 555-0122',email:'—',lastComm:'Call · 12d ago',lastCommTs:17000,nextTask:'—',offer:'$171,000',created:'Jul 27',tags:['Listed with agent'],market:'DFW',
    motivation:'Testing market',timeline:'—',condition:'Good · C2',occupancy:'Owner occupied',mortgage:'$120,000',asking:'$240,000',desiredClose:'—',decisionMakers:'Bruce',
    property:{addr:'5518 Ridgecrest Rd',city:'Dallas',st:'TX',zip:'75231',beds:3,baths:2,sqft:1580,year:1975,lot:'0.21 ac',type:'SFR',img:IMG.n,apn:'00000404112000000'}},
  {id:'p15',name:'Olivia Reyes',stage:'New Lead',score:68,assigned:null,source:'Google PPC',phone:'(512) 555-0141',email:'olivia.reyes@gmail.com',lastComm:'—',lastCommTs:null,nextTask:'First call · Now',offer:null,created:'Today 9:38 AM',tags:[],market:'Austin',
    motivation:'Inherited property',timeline:'Unknown',condition:'Unknown',occupancy:'Vacant',mortgage:'Free & clear',asking:'—',desiredClose:'—',decisionMakers:'Olivia + 2 siblings',
    property:{addr:'2115 Alamo Heights Blvd',city:'Austin',st:'TX',zip:'78704',beds:2,baths:1,sqft:1120,year:1958,lot:'0.16 ac',type:'SFR',img:IMG.o,apn:'01040508090000'}},
];

const deals = [
  {id:'d1',personId:'p1',contract:null,arv:318000,rehab:48200,assignment:22000,profit:22000,close:null,daysInStage:3,health:'good',owner:'taylor'},
  {id:'d2',personId:'p2',contract:186000,arv:262000,rehab:31000,assignment:18000,profit:18000,close:null,daysInStage:6,health:'watch',owner:'diego',structure:'JV'},
  {id:'d3',personId:'p3',contract:null,arv:null,rehab:null,assignment:null,profit:null,close:null,daysInStage:0,health:'good',owner:null},
  {id:'d4',personId:'p4',contract:198500,arv:281000,rehab:29500,assignment:21000,profit:21000,close:null,daysInStage:9,health:'watch',owner:'taylor'},
  {id:'d5',personId:'p5',contract:265000,arv:362000,rehab:38000,assignment:31000,profit:31000,close:'Sept 12',daysInStage:11,health:'good',owner:'diego',structure:'Novation'},
  {id:'d6',personId:'p6',contract:214000,arv:345000,rehab:52000,assignment:22000,profit:22000,close:'Sept 22',daysInStage:5,health:'good',owner:'morgan',structure:'Assignment'},
  {id:'d7',personId:'p7',contract:188000,arv:256000,rehab:24000,assignment:16000,profit:16000,close:null,daysInStage:12,health:'risk',owner:'taylor'},
  {id:'d8',personId:'p8',contract:176000,arv:241000,rehab:27000,assignment:19000,profit:19000,close:'Sept 6',daysInStage:14,health:'good',owner:'casey',structure:'Double Close'},
  {id:'d9',personId:'p9',contract:200000,arv:298000,rehab:45000,assignment:21000,profit:21000,close:'Sept 18',daysInStage:8,health:'watch',owner:'alex'},
  {id:'d10',personId:'p10',contract:185000,arv:248000,rehab:22000,assignment:17000,profit:17000,close:'Sept 6',daysInStage:16,health:'good',owner:'casey'},
  {id:'d11',personId:'p11',contract:null,arv:null,rehab:null,assignment:null,profit:null,close:null,daysInStage:2,health:'good',owner:'diego'},
  {id:'d12',personId:'p12',contract:null,arv:246000,rehab:30000,assignment:null,profit:null,close:null,daysInStage:1,health:'good',owner:'taylor'},
  {id:'d13',personId:'p13',contract:null,arv:null,rehab:null,assignment:null,profit:null,close:null,daysInStage:23,health:'good',owner:'diego'},
  {id:'d14',personId:'p14',contract:null,arv:236000,rehab:12000,assignment:null,profit:null,close:null,daysInStage:12,health:'risk',owner:'taylor'},
  {id:'d15',personId:'p15',contract:null,arv:null,rehab:null,assignment:null,profit:null,close:null,daysInStage:0,health:'good',owner:null},
];

const buyers = [
  {id:'b1',name:'Chris Anderson',company:'Harbor Capital',initials:'HC',status:'VIP',markets:['DFW','San Antonio','Houston'],type:'Institutional · Rental',engagement:89,stars:5,phone:'(214) 555-0201',email:'chris@harborcap.com',pref:'SMS',doNot:'Call after 5 PM',
    buyBox:{price:'$100K – $350K',year:'1990+',sqft:'1,000+',beds:'3+',baths:'2+',type:'SFR',rehab:'Light / Medium',exit:'Rental',minCap:'6%',maxCashOut:'75%',minCashFlow:'$250',avoid:['Flood zones','Septic','Major roads']},
    match:96,ceiling:'$350K',rehabTol:'Heavy',strategy:'Rental',lastPurchase:'Jul 14 · 4481 Elm St',lastActivity:'12m ago',offers:'7 submitted · 3 won',
    why:['Buys DFW','Max price $350K','SFR','Heavy rehab allowed','Purchased 3 similar properties','Active in last 30 days'],issue:'Target margin slightly below historical average.',
    activity:{calls:14,texts:42,emails:31,viewed:58,clicks:22,offers:7,walkthroughs:5,purchases:3,declines:2},summary:['Opened last 7 campaigns','Clicked 4 properties','Submitted 2 offers','Purchased 1 property']},
  {id:'b2',name:'Jordan Lee',company:'Northline Homes',initials:'NH',status:'Active',markets:['DFW'],type:'Flipper',engagement:18,sent:8,stars:4,phone:'(972) 555-0210',email:'jordan@northlinehomes.com',pref:'Email',doNot:'—',
    buyBox:{price:'$120K – $300K',year:'1970+',sqft:'1,200+',beds:'3+',baths:'2+',type:'SFR',rehab:'Light',exit:'Flip',minCap:'—',maxCashOut:'—',minCashFlow:'—',avoid:['Foundation issues']},
    match:91,ceiling:'$300K',rehabTol:'Light',strategy:'Flip',lastPurchase:'—',lastActivity:'2h ago',offers:'4 submitted · 0 won',
    why:['Buys Dallas','Under $300K','SFR','Recent flip within 1.2 mi'],issue:'Rehab scope above stated tolerance (heavy vs light).',
    activity:{calls:6,texts:18,emails:22,viewed:31,clicks:12,offers:4,walkthroughs:3,purchases:0,declines:3},summary:['Replied to 1 of 8 deals sent','Submitted 4 offers','Has not closed one']},
  {id:'b3',name:'Dana Ortiz',company:'Blue Mesa Investments',initials:'BM',status:'Active',markets:['DFW','Austin'],type:'Landlord',engagement:81,stars:4,phone:'(469) 555-0233',email:'dana@bluemesa.co',pref:'Call',doNot:'—',
    buyBox:{price:'$80K – $280K',year:'Any',sqft:'900+',beds:'2+',baths:'1+',type:'SFR / Duplex',rehab:'Any',exit:'BRRRR',minCap:'7%',maxCashOut:'80%',minCashFlow:'$300',avoid:['HOA']},
    match:86,ceiling:'$280K',rehabTol:'Any',strategy:'BRRRR',lastPurchase:'Aug 1 · 77 Grant Ave',lastActivity:'Yesterday',offers:'9 submitted · 4 won',
    why:['Buys Tarrant/Dallas','Any condition','SFR','Closed 9 days avg'],issue:'Price ceiling $280K — offer likely below target assignment.',
    activity:{calls:11,texts:27,emails:14,viewed:44,clicks:19,offers:9,walkthroughs:6,purchases:4,declines:1},summary:['Opened 6 of last 7 campaigns','Requested 2 walkthroughs','Submitted 3 offers']},
  {id:'b4',name:'Acquisitions Desk',company:'Amherst',initials:'AM',status:'Institutional',markets:['DFW','Houston','San Antonio','Austin'],type:'Institutional · SFR Rental',engagement:62,stars:3,phone:'(214) 555-0260',email:'acq@amherst.com',pref:'Email',doNot:'No weekend contact',
    buyBox:{price:'$150K – $400K',year:'1985+',sqft:'1,250+',beds:'3+',baths:'2+',type:'SFR',rehab:'Light / Medium',exit:'Rental',minCap:'5.5%',maxCashOut:'—',minCashFlow:'—',avoid:['Flood zones','Septic','Manufactured']},
    match:96,ceiling:'$400K',rehabTol:'Medium',strategy:'Rental',lastPurchase:'Aug 20 · 3 properties',lastActivity:'3d ago',offers:'22 submitted · 9 won',
    why:['Buy box covers 78254','1996 build > 1985 floor','2,140 sf > 1,250 floor','4/2 SFR','No flood zone'],issue:'Prefers vacant at close; seller needs 14-day leaseback.',
    activity:{calls:3,texts:0,emails:48,viewed:120,clicks:41,offers:22,walkthroughs:2,purchases:9,declines:6},summary:['Portal-driven','Responds within 48h']},
  {id:'b5',name:'Priya Nair',company:'Fortune Acquisitions',initials:'FA',status:'Active',markets:['San Antonio','Austin'],type:'Fund · Flip + Rental',engagement:77,stars:4,phone:'(210) 555-0271',email:'priya@fortuneacq.com',pref:'SMS',doNot:'—',
    buyBox:{price:'$120K – $380K',year:'1980+',sqft:'1,100+',beds:'3+',baths:'2+',type:'SFR',rehab:'Medium / Heavy',exit:'Flip',minCap:'—',maxCashOut:'—',minCashFlow:'—',avoid:['Foundation']},
    match:91,ceiling:'$380K',rehabTol:'Heavy',strategy:'Flip',lastPurchase:'Jul 28 · 1180 Castroville',lastActivity:'Today',offers:'6 submitted · 2 won',
    why:['Buys San Antonio NW','Heavy rehab OK','ARV window $280K–$340K matches'],issue:'Wants 10-day inspection period.',
    activity:{calls:8,texts:25,emails:19,viewed:39,clicks:15,offers:6,walkthroughs:4,purchases:2,declines:2},summary:['Opened last 4 campaigns','Submitted 1 offer this month']},
  {id:'b6',name:'Tom Reyes',company:'Evergreen Residential',initials:'ER',status:'Active',markets:['San Antonio'],type:'Landlord',engagement:58,stars:3,phone:'(210) 555-0288',email:'tom@evergreenres.com',pref:'Email',doNot:'—',
    buyBox:{price:'$90K – $260K',year:'1975+',sqft:'1,000+',beds:'3+',baths:'1.5+',type:'SFR',rehab:'Light',exit:'Rental',minCap:'7.5%',maxCashOut:'70%',minCashFlow:'$350',avoid:['Flood zones']},
    match:86,ceiling:'$260K',rehabTol:'Light',strategy:'Rental',lastPurchase:'May 9 · 402 Perrin',lastActivity:'6d ago',offers:'3 submitted · 1 won',
    why:['Buys 78254','3+ beds','Rental exit'],issue:'Ceiling $260K below expected contract + assignment.',
    activity:{calls:2,texts:9,emails:16,viewed:21,clicks:7,offers:3,walkthroughs:1,purchases:1,declines:1},summary:['Opened 3 of last 7 campaigns']},
  {id:'b7',name:'Marcus Bell',company:'Lone Star Rentals',initials:'LS',status:'Active',markets:['DFW','Houston'],type:'Landlord',engagement:69,stars:3,phone:'(817) 555-0295',email:'marcus@lonestarrentals.com',pref:'Call',doNot:'—',
    buyBox:{price:'$100K – $250K',year:'1970+',sqft:'1,100+',beds:'3+',baths:'2+',type:'SFR',rehab:'Medium',exit:'Rental',minCap:'8%',maxCashOut:'75%',minCashFlow:'$300',avoid:['Septic']},
    match:78,ceiling:'$250K',rehabTol:'Medium',strategy:'Rental',lastPurchase:'Jun 30 · 118 Ash Ln',lastActivity:'1d ago',offers:'5 submitted · 2 won',
    why:['Buys Dallas','Medium rehab OK'],issue:'Sqft slightly below preference.',
    activity:{calls:7,texts:20,emails:12,viewed:28,clicks:9,offers:5,walkthroughs:3,purchases:2,declines:2},summary:['Opened 4 of last 7 campaigns']},
];

// Communications timeline for Kara (p1)
const timeline = [
  {id:'t1',type:'call',user:'taylor',who:'Taylor Reed',time:'Today 9:42 AM',title:'Outbound call · 4m 12s',recording:true,
    ai:{summary:'Seller values speed and certainty over maximum price. Moving before September. Needs help with moving expenses.',objections:['Wants $235K','Worried about closing timeline'],next:'Send revised offer before 2 PM.'}},
  {id:'t2',type:'sms_in',user:null,who:'Kara Mitchell',time:'Today 9:31 AM',title:'Text received',body:'Hi Taylor, I looked over the numbers again. Can you call me this morning? I want to talk through the timeline.'},
  {id:'t0m',type:'call',user:null,who:'Kara Mitchell',time:'Today 8:14 AM',title:'Missed call',body:'Rang this browser and was not answered.'},
  {id:'t2e',type:'email',user:null,who:'kara.mitchell@gmail.com',time:'Yesterday 6:02 PM',title:'Email received',body:'',
    email:{subject:'Re: Your cash offer for 1803 Cypress Lane',from:'kara.mitchell@gmail.com',fromName:'Kara Mitchell',to:['taylor@acmehomes.com','diego@acmehomes.com'],inbound:true,
      body:'Hi Taylor,\r\n\r\nThank you for sending this over so quickly. My brother and I read through the offer tonight and we are both comfortable with the price, but we would need a closing date after\r\nSeptember 15 so the kids can finish their first weeks of school.\r\n\r\nIs that something you can do? Also, can we leave the old washer and dryer in the garage?\r\n\r\nThanks,\r\nKara\r\n\r\nSent from my iPhone\r\n\r\nOn Mon, Sep 21, 2026 at 3:40 PM Taylor Reed <taylor@acmehomes.com> wrote:\r\n> Kara, here is the written offer we discussed: clozr.link/o/8f2k.\r\n> No obligation, happy to walk through it whenever.'}},
  {id:'t3',type:'offer',user:'taylor',who:'Taylor Reed',time:'Yesterday 4:15 PM',title:'Offer viewed by seller · 3rd time',body:'Offer link opened from mobile. Time on page 2m 40s.'},
  {id:'t4',type:'compr',user:'taylor',who:'COMPR',time:'Yesterday 3:58 PM',title:'Underwriting report generated',body:'ARV $318,000 · Confidence 92 · Rehab $48,200 – $57,600 · MAO (Wholesale) $181,400'},
  {id:'t4e',type:'email',user:'taylor',who:'Taylor Reed',time:'Yesterday 3:52 PM',title:'Email sent',body:'',
    email:{subject:'Your cash offer for 1803 Cypress Lane',from:'taylor@acmehomes.com',fromName:'',to:['kara.mitchell@gmail.com'],inbound:false,
      body:'Hi Kara,\r\n\r\nAs promised, here is our written cash offer for 1803 Cypress Lane: $186,000, as-is, no repairs, no commissions, and we cover the closing costs.\r\n\r\nYou pick the closing date. Reply here or call me with any questions.\r\n\r\nNatalie Reed\r\nAcme Homes'}},
  {id:'t5',type:'sms_out',user:'taylor',who:'Taylor Reed',time:'Yesterday 3:40 PM',title:'Outbound SMS',body:'Kara, here is the written offer we discussed: clozr.link/o/8f2k. No obligation — happy to walk through it whenever.'},
  {id:'t6',type:'stage',user:'taylor',who:'Taylor Reed',time:'Yesterday 2:12 PM',title:'Stage changed · Contacted → Qualified',body:'Motivation confirmed. Decision makers identified.'},
  {id:'t7',type:'note',user:'taylor',who:'Taylor Reed',time:'Yesterday 2:10 PM',title:'Note',body:'Brother is co-heir; lives in Phoenix. Kara handles everything but wants him on the final call. Prefers text before calls.'},
  {id:'t8',type:'email',user:'taylor',who:'Taylor Reed',time:'Aug 23 · 10:04 AM',title:'Email sent',body:'Intro packet sent. Opened twice.',
    email:{subject:'How our process works',from:'taylor@acmehomes.com',fromName:'',to:['kara.mitchell@gmail.com'],inbound:false,
      body:'<!DOCTYPE html><html><body><div style="font-family:Arial,Helvetica,sans-serif;max-width:560px"><div style="background:#0A8560;color:#ffffff;padding:16px 20px;font-size:18px;font-weight:700">How our process works</div><div style="padding:16px 20px;color:#18181b;font-size:14px;line-height:1.5"><p>Hi Kara,</p><p>Thanks for taking the time to talk today. Here is how selling to us works, start to finish.</p><table style="width:100%;border-collapse:collapse"><tr><td style="padding:8px 8px;border-bottom:1px solid #e4e4e7"><b>1. Walkthrough</b></td><td style="padding:8px 8px;border-bottom:1px solid #e4e4e7">About 20 minutes at the house</td></tr><tr><td style="padding:8px 8px;border-bottom:1px solid #e4e4e7"><b>2. Written offer</b></td><td style="padding:8px 8px;border-bottom:1px solid #e4e4e7">A cash offer within 24 hours</td></tr><tr><td style="padding:8px 8px"><b>3. Your closing date</b></td><td style="padding:8px 8px">As soon as 10 days, on the day you pick</td></tr></table><p>No repairs, no cleaning, no commissions.</p><p><a href="https://example.com/how-we-buy">Read the one-page overview</a></p><p style="color:#71717a">Taylor Reed · Acquisitions · Acme Homes · (210) 555-0100</p></div></div></body></html>'}},
  {id:'t9',type:'task',user:'system',who:'Automation',time:'Aug 22 · 8:52 AM',title:'Action plan started · Google PPC Speed-to-Lead',body:'SMS sent 0:00 · Call task created 0:00 · Second SMS 15:00'},
  {id:'t10',type:'lead',user:'system',who:'Lead Intake',time:'Aug 22 · 8:51 AM',title:'Lead created · Google PPC',body:'Form: "Sell my house fast San Antonio". Assigned to Taylor Reed by round-robin.'},
];

const comps = [
  {id:'c1',addr:'142 Eagles Landing Dr',dist:0.4,sale:'Mar 2026',price:412500,ppsf:171,sqft:2410,beds:4,baths:3,year:1998,stories:2,cond:'C2',sub:'Oakview Estates',inc:true,x:36,y:28,img:IMG.b,reason:'Same subdivision · superior condition, adjusted −$8,400'},
  {id:'c2',addr:'88 Highland Pkwy',dist:0.6,sale:'Jan 2026',price:298000,ppsf:159,sqft:1870,beds:3,baths:2,year:1995,stories:1,cond:'C3',sub:'Oakview Estates',inc:true,x:62,y:22,img:IMG.c,reason:'Smaller · adjusted +$11,200 for GLA'},
  {id:'c3',addr:'23 Brookwood Ct',dist:0.7,sale:'Feb 2026',price:331900,ppsf:151,sqft:2200,beds:4,baths:2,year:1997,stories:1,cond:'C3',sub:'Oakview Estates',inc:true,x:44,y:66,img:IMG.d,reason:'Closest match · no adjustment'},
  {id:'c4',addr:'5109 Culebra Crossing',dist:0.9,sale:'Apr 2026',price:274000,ppsf:138,sqft:1980,beds:3,baths:2,year:1994,stories:1,cond:'C4',inc:false,sub:'Culebra Park',x:78,y:70,img:IMG.e,reason:'Rejected · crosses Culebra Rd (major arterial) and belongs to a different subdivision pricing cluster.'},
  {id:'c5',addr:'210 Timber Path',dist:1.1,sale:'Dec 2025',price:345000,ppsf:162,sqft:2130,beds:4,baths:2.5,year:2003,stories:2,cond:'C2',inc:false,sub:'Timber Ridge',x:18,y:74,img:IMG.g,reason:'Rejected · newer build era and 2-story; different buyer pool.'},
  {id:'c6',addr:'9 Oakview Ct',dist:0.2,sale:'Nov 2025',price:309000,ppsf:148,sqft:2090,beds:4,baths:2,year:1996,stories:1,cond:'C3',inc:true,sub:'Oakview Estates',x:52,y:44,img:IMG.h,reason:'Same street · sale slightly dated, adjusted +$4,600 for market'},
];

const rehab = [
  {k:'Roof',low:0,med:9500,heavy:14200},{k:'HVAC',low:0,med:6800,heavy:9200},{k:'Kitchen',low:6500,med:12400,heavy:18500},{k:'Bathrooms',low:3200,med:7600,heavy:12000},
  {k:'Flooring',low:4800,med:7900,heavy:9600},{k:'Paint',low:3600,med:5200,heavy:6400},{k:'Windows',low:0,med:2400,heavy:8800},{k:'Foundation',low:0,med:0,heavy:11000},
  {k:'Exterior',low:1800,med:3400,heavy:6200},{k:'Landscaping',low:900,med:1600,heavy:2800},{k:'Misc.',low:1500,med:2400,heavy:3600},
];

const exits = [
  {k:'Wholesale',offer:181400,profit:22000,note:'Assignment fee · 14-day close'},
  {k:'Flip',offer:196800,profit:41300,note:'6-month hold · 8% selling costs'},
  {k:'Rental',offer:204200,profit:412,note:'$412/mo cash flow · 6.8% cap'},
  {k:'BRRRR',offer:199600,profit:18900,note:'75% LTV refi · $18.9K cash left in'},
  {k:'Novation',offer:222500,profit:34800,note:'List at $318K · seller net $222.5K'},
  {k:'Wholetail',offer:208000,profit:27600,note:'Clean & list as-is · 60-day hold'},
];

const propertyIntel = [
  ['Flood','Zone X · minimal risk','good'],['School district','Northside ISD · 7/10','good'],['Crime','Below county median','good'],['Road type','Residential cul-de-sac','good'],
  ['Commercial adjacency','None within 500 ft','good'],['Subdivision','Oakview Estates (1994–1999)','neutral'],['Lot','0.21 ac · rectangular · rear alley','neutral'],['Topography','Flat · no drainage flags','good'],
  ['HOA','None','good'],['Taxes','$5,840 / yr · Bexar','neutral'],['Permits','Roof 2011 · HVAC none on file','caution'],['Liens','Tax lien indicator · $2,310 (2024)','caution'],
  ['Market velocity','Median DOM 24 · sellers market','good'],['DOM (subdivision)','19 days','good'],['Price trend','+3.1% YoY','good'],
];

const inbox = [
  {id:'i1',personId:'p1',channel:'sms',preview:'Hi Taylor, I looked over the numbers again. Can you call me this morning?',time:'9:31 AM',unread:2,assigned:'taylor'},
  {id:'i2',personId:'p2',channel:'sms',preview:'Got the offer. Thinking it over with my wife tonight.',time:'8:56 AM',unread:1,assigned:'diego'},
  {id:'i3',personId:'p8',channel:'email',preview:'Northvale Title: Closing disclosure ready for review — Pine Terrace',time:'7:02 AM',unread:1,assigned:'casey'},
  {id:'i4',buyerId:'b1',channel:'sms',preview:'Can we get in Willow tomorrow at 2:30? Bringing my GC.',time:'Yesterday',unread:0,assigned:'morgan'},
  {id:'i5',personId:'p4',channel:'email',preview:'Re: Repair breakdown — can you itemize the foundation piece?',time:'Yesterday',unread:0,assigned:'taylor'},
  {id:'i6',personId:'p12',channel:'voicemail',preview:'Voicemail · 0:48 · "Confirming Saturday at 10, call me back"',time:'Yesterday',unread:1,assigned:'taylor'},
  {id:'i7',personId:'p11',channel:'sms',preview:'Not ready yet but keep me posted on values in Plano.',time:'Aug 30',unread:0,assigned:'diego'},
  {id:'i8',buyerId:'b3',channel:'call',preview:'Missed call · 2 attempts',time:'Aug 30',unread:1,assigned:'alex'},
];

const tasks = [
  {id:'k1',title:'Call seller — discuss revised offer',personId:'p1',type:'Call',due:'Today 1:30 PM',assigned:'taylor',priority:'High',done:false,bucket:'today'},
  {id:'k2',title:'Follow up 1803 Cypress — offer opened 3×',personId:'p2',type:'Follow-up',due:'Overdue · 2h',assigned:'diego',priority:'High',done:false,bucket:'overdue'},
  {id:'k3',title:'First call — new Facebook lead',personId:'p3',type:'Call',due:'Now',assigned:null,priority:'Urgent',done:false,bucket:'today'},
  {id:'k4',title:'Confirm walkthrough with Harbor Capital',personId:'p6',type:'Dispo',due:'Today 4:00 PM',assigned:'morgan',priority:'Medium',done:false,bucket:'today'},
  {id:'k5',title:'Collect buyer EMD — Pine Terrace',personId:'p8',type:'TC',due:'Overdue · 6h',assigned:'casey',priority:'Urgent',done:false,bucket:'overdue'},
  {id:'k6',title:'Send itemized repair breakdown',personId:'p4',type:'Email',due:'Tomorrow 10:00 AM',assigned:'taylor',priority:'Medium',done:false,bucket:'upcoming'},
  {id:'k7',title:'Inspection access — coordinate with Andrea',personId:'p5',type:'TC',due:'Aug 26',assigned:'casey',priority:'Medium',done:false,bucket:'upcoming'},
  {id:'k8',title:'Review 2 offers — Easton Avenue',personId:'p9',type:'Dispo',due:'Today 5:00 PM',assigned:'alex',priority:'High',done:false,bucket:'today'},
  {id:'k9',title:'Walkthrough — Brookhollow Dr',personId:'p12',type:'Appointment',due:'Sat 10:00 AM',assigned:'taylor',priority:'Medium',done:false,bucket:'upcoming'},
  {id:'k10',title:'Send intro packet',personId:'p11',type:'Email',due:'Yesterday',assigned:'diego',priority:'Low',done:true,bucket:'completed'},
  {id:'k11',title:'Order title — Willow Street',personId:'p6',type:'TC',due:'Aug 29',assigned:'casey',priority:'Medium',done:true,bucket:'completed'},
];

const notifications = [
  {id:'n1',cat:'Offer',text:'Harbor Capital submitted a new offer on Willow Street — $238,500',time:'10:02 AM',unread:true,link:{screen:'dispoProperty',id:'p6'}},
  {id:'n2',cat:'Seller',text:'Kara Mitchell replied by SMS',time:'9:31 AM',unread:true,link:{screen:'person',id:'p1',tab:'Texts'}},
  {id:'n3',cat:'Seller',text:'Lead untouched for 10 minutes — John Smith (Facebook PPC)',time:'9:01 AM',unread:true,link:{screen:'person',id:'p3'}},
  {id:'n4',cat:'Buyer',text:'Blue Mesa opened Easton Avenue 3 times',time:'8:44 AM',unread:true,link:{screen:'buyer',id:'b3'}},
  {id:'n5',cat:'Dispo',text:'Walkthrough requested — Willow Street, tomorrow 2:30 PM',time:'Yesterday',unread:false,link:{screen:'dispoProperty',id:'p6'}},
  {id:'n6',cat:'TC',text:'Buyer EMD overdue — Pine Terrace (closing in 5 days)',time:'Yesterday',unread:true,link:{screen:'tc',id:'p8'}},
  {id:'n7',cat:'TC',text:'Closing moved — Cedar Way now Sept 6',time:'Yesterday',unread:false,link:{screen:'tc',id:'p10'}},
  {id:'n8',cat:'System',text:'Contract executed — Benton Court',time:'Aug 30',unread:false,link:{screen:'person',id:'p5'}},
  {id:'n9',cat:'Call',text:'Missed call from Kara Mitchell',time:'Today 8:14 AM',unread:true,link:{screen:'person',id:'p1',tab:'Calls'}},
  {id:'n10',cat:'SMS',text:'Text from Kara Mitchell — Hi Taylor, I looked over the numbers again.',time:'Today 9:31 AM',unread:true,link:{screen:'person',id:'p1',tab:'Texts'}},
];

const offers = [
  {id:'o1',buyerId:'b1',offer:238500,emd:10000,inspection:'None · as-is',closing:'11 days',financing:'Cash',pof:'Verified',terms:'As-is · no contingencies',confidence:94,flags:['Best net','Strongest terms']},
  {id:'o2',buyerId:'b2',offer:241000,emd:5000,inspection:'7 days',closing:'18 days',financing:'Cash',pof:'Verified',terms:'Inspection contingency',confidence:78,flags:['Highest offer']},
  {id:'o3',buyerId:'b3',offer:235750,emd:12500,inspection:'None · as-is',closing:'9 days',financing:'Cash',pof:'Verified',terms:'As-is · $12.5K hard EMD',confidence:90,flags:['Fastest close']},
  {id:'o4',buyerId:'b7',offer:233000,emd:5000,inspection:'5 days',closing:'21 days',financing:'Hard money',pof:'Pending',terms:'Lender approval',confidence:61,flags:[]},
];

const walkthroughs = [
  {id:'w1',buyerId:'b1',personId:'p6',date:'Fri Sept 5',time:'2:30 PM',status:'Confirmed'},
  {id:'w2',buyerId:'b3',personId:'p6',date:'Fri Sept 5',time:'2:30 PM',status:'Requested'},
  {id:'w3',buyerId:'b2',personId:'p6',date:'Sat Sept 6',time:'10:00 AM',status:'Confirmed'},
  {id:'w4',buyerId:'b5',personId:'p9',date:'Thu Sept 4',time:'11:00 AM',status:'Completed'},
  {id:'w5',buyerId:'b7',personId:'p9',date:'Wed Sept 3',time:'3:00 PM',status:'No Show'},
];

const engagementFeed = [
  ['9:41 AM','Harbor Capital opened email'],['9:43 AM','Viewed photos (12)'],['9:44 AM','Opened COMPR underwriting report'],['9:47 AM','Requested walkthrough · Fri 2:30 PM'],['10:02 AM','Submitted $238,500 offer'],
  ['10:15 AM','Northline Homes clicked property link'],['10:22 AM','Blue Mesa viewed photos (7)'],['10:40 AM','Northline Homes submitted $241,000 offer'],
];

const tcItems = [
  {k:'Purchase Contract',done:true,owner:'Acquisitions',date:'Aug 27'},{k:'Assignment Contract',done:true,owner:'Dispo',date:'Sept 2'},{k:'Seller EMD',done:true,owner:'TC',date:'Aug 28'},
  {k:'Buyer EMD',done:false,owner:'Buyer',date:'Overdue 6h',blocker:'critical'},{k:'Title Open',done:true,owner:'Northvale Title',date:'Aug 29'},{k:'Title Commitment',done:true,owner:'Northvale Title',date:'Sept 2',blocker:'warning'},
  {k:'Inspection',done:true,owner:'Buyer',date:'Sept 3'},{k:'Access',done:true,owner:'Seller',date:'Sept 3'},{k:'Utilities',done:false,owner:'TC',date:'Due Sept 8'},{k:'Payoffs',done:true,owner:'Title',date:'N/A · free & clear'},
  {k:'Liens',done:true,owner:'Title',date:'Clear'},{k:'HOA',done:true,owner:'TC',date:'None'},{k:'Closing Disclosure',done:false,owner:'Title',date:'Due Sept 15'},{k:'Settlement Statement',done:false,owner:'Title',date:'Due Sept 18'},
  {k:'Final Walkthrough',done:false,owner:'Buyer',date:'Sept 19'},{k:'Funding',done:false,owner:'Buyer',date:'Sept 22'},{k:'Recorded',done:false,owner:'Title',date:'Sept 22'},{k:'Paid',done:false,owner:'Acme Homes',date:'Sept 22'},
];

const tcBlockers = [
  {level:'CRITICAL',text:'Buyer EMD overdue by 6 hours.',who:'Harbor Capital · Casey Park notified'},
  {level:'WARNING',text:'Seller initials missing page 8.',who:'Assignment addendum · sent for e-sign 9:12 AM'},
  {level:'WARNING',text:'Title commitment exception #6 requires review.',who:'Northvale Title · easement (rear alley)'},
];

const tcFeed = [
  {who:'Northvale Title',role:'Title',time:'10:12 AM',text:'Commitment issued. Schedule B exception #6 (utility easement) flagged for review.'},
  {who:'Casey Park',role:'TC',time:'9:12 AM',text:'Sent assignment addendum for seller initials (page 8).'},
  {who:'Chris Anderson · Harbor Capital',role:'Buyer',time:'Yesterday 5:40 PM',text:'"Wire going out first thing tomorrow." — EMD not yet received.'},
  {who:'Morgan Lane',role:'Dispo',time:'Yesterday 3:05 PM',text:'Assignment executed. Buyer: Harbor Capital · $238,500 · Assignment fee $24,500.'},
  {who:'Patricia Hale',role:'Seller',time:'Yesterday 1:22 PM',text:'Confirmed access code for inspection. Property vacant.'},
  {who:'Diego Ortiz',role:'Acquisitions',time:'Aug 27',text:'Purchase contract executed at $214,000. EMD $2,500 to Northvale.'},
];

// Action plans — multi-step follow-up sequences a seller can be enrolled in.
// `content` is the message body for a channel step; it is a plain string so a
// later AI layer can generate it without changing the shape (see `generated`).
const actionPlans = [
  {id:'ap1',name:'Google PPC Speed-to-Lead',trigger:'Lead created · Source = Google PPC',active:true,audience:'seller',
    description:'First-touch cadence for paid search leads. Speed is the whole game.',
    steps:[
      {id:'ap1s1',channel:'sms',delay:'Immediately',title:'First text',content:'Hi {{first_name}}, this is {{rep}} with Acme Homes — you asked about selling {{address}}. Is now an ok time for a quick call?',generated:false},
      {id:'ap1s2',channel:'call',delay:'Immediately',title:'Call task',content:'Call the lead. Confirm motivation, timeline and condition.',generated:false},
      {id:'ap1s3',channel:'sms',delay:'After 15 minutes',title:'Second text',content:'No rush {{first_name}} — happy to text instead if that is easier. What has you thinking about selling?',generated:false},
      {id:'ap1s4',channel:'email',delay:'After 1 hour',title:'Intro packet',content:'"How our process works" — what to expect, timeline, and what we cover at closing.',generated:false},
      {id:'ap1s5',channel:'call',delay:'Day 2',title:'Second call attempt',content:'Second attempt. Try a different time of day than the first.',generated:false},
      {id:'ap1s6',channel:'sms',delay:'Day 3',title:'Value text',content:'{{first_name}}, pulled comps on {{address}} — happy to send what it would take to close in 14 days.',generated:false},
      {id:'ap1s7',channel:'task',delay:'Day 5',title:'Manual review',content:'Review the lead. Requalify or move to long-term follow-up.',generated:false},
      {id:'ap1s8',channel:'email',delay:'Day 7',title:'Break-up email',content:'Closing the loop — reply any time and we will pick it back up.',generated:false},
    ]},
  {id:'ap2',name:'Offer Sent Follow-Up',trigger:'Stage → Offer Sent',active:true,audience:'seller',
    description:'Keeps an offer alive without nagging. Stops the moment the stage moves.',
    steps:[
      {id:'ap2s1',channel:'sms',delay:'After 2 hours',title:'Confirm receipt',content:'{{first_name}}, just want to make sure the offer came through — any questions on it?',generated:false},
      {id:'ap2s2',channel:'call',delay:'Day 1',title:'Walk the numbers',content:'Call and walk the numbers line by line. Ask what would make it an easy yes.',generated:false},
      {id:'ap2s3',channel:'email',delay:'Day 3',title:'Repair breakdown',content:'Itemised repair breakdown so the number is not a mystery.',generated:false},
      {id:'ap2s4',channel:'sms',delay:'Day 5',title:'Expiry nudge',content:'Offer on {{address}} is good through {{expiry}} — want me to hold it open?',generated:false},
    ]},
  {id:'ap3',name:'Long-Term Nurture',trigger:'Tag = Long-term',active:true,audience:'seller',
    description:'Low-touch monthly cadence for sellers who are 6+ months out.',
    steps:[
      {id:'ap3s1',channel:'sms',delay:'Day 30',title:'Check in',content:'{{first_name}}, no pressure — still thinking about {{address}}?',generated:false},
      {id:'ap3s2',channel:'email',delay:'Day 60',title:'Market update',content:'What homes like yours in {{city}} have sold for in the last 60 days.',generated:false},
      {id:'ap3s3',channel:'call',delay:'Day 90',title:'Quarterly call',content:'Quarterly touch. Requalify timeline and motivation.',generated:false},
    ]},
  {id:'ap4',name:'Under Contract → TC Handoff',trigger:'Stage → Under Contract',active:true,audience:'tc',
    description:'Hands the file to the TC and sets the seller expectations for close. Available on sellers, buyers, and vendors.',
    steps:[
      {id:'ap4s1',channel:'task',delay:'Immediately',title:'Open TC file',content:'Open the transaction file and start the contract-to-close checklist.',generated:false},
      {id:'ap4s2',channel:'sms',delay:'Immediately',title:'TC introduction',content:'{{first_name}}, {{tc}} is your transaction coordinator from here — she will handle title and closing.',generated:false},
      {id:'ap4s3',channel:'email',delay:'Day 1',title:'Seller info sheet',content:'Seller info sheet: mortgage, HOA, occupancy, keys and utilities.',generated:false},
    ]},
  {id:'ap5',name:'New buyer welcome',trigger:'Manual enrollment',active:true,audience:'buyer',
    description:'First-week cadence after a buyer is added to the list.',
    steps:[
      {id:'ap5s1',channel:'sms',delay:'Immediately',title:'Welcome text',content:'Hi {{first_name}} — this is {{rep}} with Acme Homes. Got your buy box. I will ping you when something fits.',generated:false},
      {id:'ap5s2',channel:'email',delay:'Day 1',title:'Buy box confirm',content:'Confirming the markets and price range we have on file. Reply with anything to tighten.',generated:false},
      {id:'ap5s3',channel:'call',delay:'Day 3',title:'Intro call',content:'Quick call. Confirm proof of funds and preferred structure.',generated:false},
    ]},
  {id:'ap6',name:'New source weekly',trigger:'Tag = New source',active:true,audience:'source',
    description:'Weekly email for a wholesaler source. Shows on vendor lists.',
    steps:[
      {id:'ap6s1',channel:'email',delay:'Immediately',title:'Week 1',content:'Hey {{first_name}}, appreciate you sending deals over. Got another one we should look at?',generated:false},
      {id:'ap6s2',channel:'email',delay:'Day 7',title:'Week 2',content:'Checking in — what else are you working this week?',generated:false},
    ]},
];

// Which sellers are enrolled in which plan, and how far through they are.
const enrollments = [
  {id:'en1',personId:'p1',planId:'ap1',step:6,status:'paused',note:'Paused while Qualified'},
  {id:'en2',personId:'p3',planId:'ap1',step:1,status:'active',note:''},
  {id:'en3',personId:'p15',planId:'ap1',step:1,status:'active',note:''},
  {id:'en4',personId:'p2',planId:'ap2',step:2,status:'active',note:''},
  {id:'en5',personId:'p7',planId:'ap2',step:4,status:'active',note:''},
  {id:'en6',personId:'p13',planId:'ap3',step:1,status:'active',note:''},
];

// Vendors — title companies, contractors and the rest of the rolodex.
const vendors = [
  {id:'v1',name:'Northvale Title',kind:'Title Company',contact:'Maria Delgado',phone:'(214) 555-0310',email:'mdelgado@northvaletitle.com',market:'DFW',rating:5,note:'Primary title. Closes assignments without friction.'},
  {id:'v2',name:'Alamo Heights Title',kind:'Title Company',contact:'Ruben Ortiz',phone:'(210) 555-0455',email:'rortiz@ahtitle.com',market:'San Antonio',rating:4,note:'Handles probate well. Slower on commitments.'},
  {id:'v3',name:'Cornerstone Roofing',kind:'Contractor',contact:'Dale Muñoz',phone:'(214) 555-0620',email:'dale@cornerstoneroof.com',market:'DFW',rating:5,note:'Fast bids, honest scope.'},
  {id:'v4',name:'Lone Star Foundation',kind:'Contractor',contact:'Priya Raman',phone:'(972) 555-0188',email:'priya@lonestarfoundation.com',market:'DFW',rating:4,note:'Engineer letters included in the bid.'},
  {id:'v5',name:'Rapid Junk Haul',kind:'Contractor',contact:'Tomas Vela',phone:'(210) 555-0733',email:'tomas@rapidjunk.com',market:'San Antonio',rating:4,note:'Same-week cleanouts on vacant properties.'},
  {id:'v6',name:'Hillcrest Lending',kind:'Lender',contact:'Ann Petrov',phone:'(512) 555-0244',email:'ann@hillcrestlending.com',market:'Austin',rating:5,note:'Transactional funding for double closes.'},
  {id:'v7',name:'BlueKey Insurance',kind:'Insurance',contact:'Marcus Webb',phone:'(713) 555-0311',email:'marcus@bluekeyins.com',market:'Houston',rating:4,note:'Vacant property policies bound same day.'},
  {id:'v8',name:'Trinity Survey Co.',kind:'Survey',contact:'Elena Faro',phone:'(214) 555-0902',email:'elena@trinitysurvey.com',market:'DFW',rating:4,note:'Turns surveys in 5 business days.'},
  {id:'v9',name:'Statewide Notary',kind:'Notary',contact:'Grace Kim',phone:'(210) 555-0512',email:'grace@statewidenotary.com',market:'All',rating:5,note:'Mobile notary, covers all four markets.'},
  {id:'v10',name:'Pace Photography',kind:'Photography',contact:'Owen Pace',phone:'(469) 555-0177',email:'owen@pacephoto.com',market:'DFW',rating:5,note:'MLS-grade photos, 24h turnaround.'},
  {id:'v11',name:'Harbor Legal',kind:'Attorney',contact:'Sonia Bright',phone:'(214) 555-0466',email:'sonia@harborlegal.com',market:'All',rating:4,note:'Novation and POA review.'},
];

const reporting = {
  kpis:[['Revenue','$486,300','+12.4%'],['Assignment revenue','$412,800','+9.1%'],['Deals closed','19','+3'],['Average assignment','$21,726','+$1,140'],['Cost per lead','$142','−$18'],['Cost per contract','$3,860','−$410'],['Marketing spend','$61,200','+4.2%'],['Speed to lead','2m 41s','−38s']],
  funnel:[['Lead → Contact','62%',62],['Contact → Offer','31%',31],['Offer → Contract','18%',18],['Contract → Close','84%',84]],
  activity:[['Calls','2,418'],['Talk time','196h 12m'],['Appointments','64'],['Follow-up attempts','4.8 avg']],
  leaderboard:[
    {rep:'taylor',calls:684,talk:'58h 40m',contacts:312,offers:41,contracts:9,revenue:'$198,400',conv:'22.0%'},
    {rep:'diego',calls:611,talk:'51h 05m',contacts:284,offers:36,contracts:7,revenue:'$164,900',conv:'19.4%'},
    {rep:'sam',calls:212,talk:'18h 22m',contacts:96,offers:11,contracts:2,revenue:'$41,500',conv:'18.2%'},
    {rep:'morgan',calls:402,talk:'33h 10m',contacts:190,offers:0,contracts:6,revenue:'$131,200',conv:'—'},
    {rep:'alex',calls:366,talk:'29h 48m',contacts:171,offers:0,contracts:4,revenue:'$88,600',conv:'—'},
    {rep:'avery',calls:355,talk:'23h 29m',contacts:150,offers:0,contracts:3,revenue:'$63,200',conv:'—'},
  ],
  sources:[['Google PPC',38,'$118'],['Direct Mail',22,'$196'],['Facebook PPC',18,'$104'],['Cold Call',10,'$61'],['Referral',7,'$0'],['Website',5,'$88']],
  monthly:[42,55,48,61,70,66,74,82,79,88,91,96],
};

const automation = {
  trigger:'New Lead Created',
  conditions:['Source = Google PPC','Market = San Antonio'],
  steps:[
    {when:'Immediately',type:'Text',text:'Send SMS · "Hi {first}, this is Taylor with Acme Homes — got your request about {address}…"'},
    {when:'Immediately',type:'Call Task',text:'Create call task · assigned round-robin (Acquisitions)'},
    {when:'After 3 minutes',type:'Branch',text:'If no outbound call → Notify Manager (Sam) via Slack'},
    {when:'After 15 minutes',type:'Text',text:'If no contact → second SMS'},
    {when:'After 6 hours',type:'Call Task',text:'Call task · priority High'},
    {when:'Next day',type:'Email',text:'Email · "How our process works"'},
    {when:'On Qualified',type:'COMPR',text:'Run COMPR underwriting · attach report to record'},
    {when:'On Under Contract',type:'Start Dispo',text:'Create dispo file · match buyers · notify Morgan'},
  ],
  palette:['Assign','Text','Email','Call Task','Task','Stage','Tag','Webhook','Slack','Wait','Branch','COMPR','Generate Offer','Start Dispo','Notify Manager'],
};

const calendar = [
  {day:'Thu 4',items:[{t:'9:00',title:'Team standup',kind:'Team'},{t:'11:00',title:'Walkthrough · Easton Ave — Fortune Acq.',kind:'Dispo'},{t:'1:30',title:'Call Kara Mitchell',kind:'Call'}]},
  {day:'Fri 5',items:[{t:'10:00',title:'Closing · Pine Terrace',kind:'TC'},{t:'2:30',title:'Walkthrough · Willow St — Harbor Capital, Blue Mesa',kind:'Dispo'},{t:'4:00',title:'Callback Teresa Vance',kind:'Call'}]},
  {day:'Sat 6',items:[{t:'10:00',title:'Appointment · Brookhollow Dr — Harold Kim',kind:'Appointment'},{t:'10:00',title:'Walkthrough · Willow St — Northline',kind:'Dispo'},{t:'12:00',title:'Funding · Cedar Way',kind:'TC'}]},
  {day:'Mon 8',items:[{t:'9:30',title:'Utilities transfer · Willow St',kind:'TC'},{t:'2:00',title:'Offer review · Lake Ridge',kind:'Call'}]},
  {day:'Tue 9',items:[{t:'10:00',title:'Offer expires · Lake Ridge',kind:'Offer'}]},
];


// Communications — every call, text, email and voicemail, tied to the record it
// concerns. `personId` is the seller the communication is about; `buyerId` is set
// instead when the other party is a buyer on that seller's property. `ts` is
// "minutes ago" (ascending = older), which is what the record timelines sort on.
const communications = [
  // p1 · Kara Mitchell · 123 Oakview Drive
  {id:'c1',personId:'p1',channel:'call',dir:'out',party:'Kara Mitchell',user:'taylor',ts:42,time:'Today 9:42 AM',preview:'Outbound call · 4m 12s — walked the revised numbers and the Sept 30 timeline.',dur:'4m 12s'},
  {id:'c2',personId:'p1',channel:'sms',dir:'in',party:'Kara Mitchell',user:null,ts:53,time:'Today 9:31 AM',preview:'Hi Taylor, I looked over the numbers again. Can you call me this morning? I want to talk through the timeline.'},
  {id:'c3',personId:'p1',channel:'sms',dir:'out',party:'Kara Mitchell',user:'taylor',ts:1010,time:'Yesterday 3:40 PM',preview:'Kara, here is the written offer we discussed: clozr.link/o/8f2k. No obligation — happy to walk through it whenever.'},
  {id:'c4',personId:'p1',channel:'email',dir:'out',party:'Kara Mitchell',user:'taylor',ts:2900,time:'Aug 23 · 10:04 AM',preview:'"How our process works" — intro packet sent. Opened twice.'},
  {id:'c5',personId:'p1',channel:'call',dir:'out',party:'Kara Mitchell',user:'taylor',ts:3100,time:'Aug 22 · 9:20 AM',preview:'First contact · 6m 48s — confirmed motivation (relocation) and co-heir brother in Phoenix.',dur:'6m 48s'},

  // p2 · Ronald Moore · 1803 Cypress Lane
  {id:'c6',personId:'p2',channel:'sms',dir:'in',party:'Ronald Moore',user:null,ts:180,time:'Today 8:56 AM',preview:'Got the offer. Thinking it over with my wife tonight.'},
  {id:'c7',personId:'p2',channel:'email',dir:'out',party:'Ronald Moore',user:'diego',ts:1500,time:'Yesterday 11:02 AM',preview:'Offer summary — $186,000, close in 21 days, we cover all closing costs.'},
  {id:'c8',personId:'p2',channel:'call',dir:'out',party:'Ronald Moore',user:'diego',ts:2880,time:'Sept 2 · 2:14 PM',preview:'Outbound call · 8m 03s — tenant situation and turnover costs.',dur:'8m 03s'},

  // p4 · Derek Ross · 81 Meadow Lane
  {id:'c9',personId:'p4',channel:'email',dir:'in',party:'Derek Ross',user:null,ts:1400,time:'Yesterday 12:20 PM',preview:'Re: Repair breakdown — can you itemize the foundation piece?'},
  {id:'c10',personId:'p4',channel:'email',dir:'out',party:'Derek Ross',user:'taylor',ts:1600,time:'Yesterday 9:40 AM',preview:'Repair breakdown attached — $29,500 total, foundation is the largest line.'},
  {id:'c11',personId:'p4',channel:'call',dir:'out',party:'Derek Ross',user:'taylor',ts:4300,time:'Sept 1 · 4:05 PM',preview:'Outbound call · 11m 20s — attorney needs to sign off before Sept 20.',dur:'11m 20s'},

  // p5 · Andrea Lopez · 44 Benton Court
  {id:'c12',personId:'p5',channel:'call',dir:'in',party:'Andrea Lopez',user:'diego',ts:95,time:'Today 8:18 AM',preview:'Inbound call · 3m 41s — confirming inspection access for Aug 26.',dur:'3m 41s'},
  {id:'c13',personId:'p5',channel:'email',dir:'out',party:'Andrea Lopez',user:'casey',ts:1450,time:'Yesterday 10:15 AM',preview:'Probate letters testamentary received by title. Closing still Sept 12.'},

  // p6 · Patricia Hale · 2207 Willow Street (dispo + TC record)
  {id:'c14',personId:'p6',channel:'sms',dir:'out',party:'Patricia Hale',user:'diego',ts:1200,time:'Yesterday 2:10 PM',preview:'Patricia — inspection is done, no surprises. Still on track for Sept 22.'},
  {id:'c15',personId:'p6',channel:'call',dir:'in',party:'Patricia Hale',user:'diego',ts:1330,time:'Yesterday 1:22 PM',preview:'Inbound call · 2m 05s — confirmed access code for inspection, property vacant.',dur:'2m 05s'},
  {id:'c16',personId:'p6',buyerId:'b1',channel:'sms',dir:'in',party:'Chris Anderson · Harbor Capital',user:null,ts:1440,time:'Yesterday 11:30 AM',preview:'Can we get in Willow tomorrow at 2:30? Bringing my GC.'},
  {id:'c17',personId:'p6',channel:'email',dir:'in',party:'Northvale Title',user:null,ts:130,time:'Today 10:12 AM',preview:'Commitment issued. Schedule B exception #6 (utility easement) flagged for review.'},
  {id:'c18',personId:'p6',channel:'email',dir:'out',party:'Patricia Hale',user:'casey',ts:170,time:'Today 9:12 AM',preview:'Assignment addendum sent for your initials — page 8 is the only one outstanding.'},
  {id:'c19',personId:'p6',buyerId:'b1',channel:'call',dir:'out',party:'Chris Anderson · Harbor Capital',user:'morgan',ts:1580,time:'Yesterday 3:05 PM',preview:'Outbound call · 5m 12s — assignment executed at $238,500, fee $24,500.',dur:'5m 12s'},
  {id:'c20',personId:'p6',channel:'call',dir:'out',party:'Patricia Hale',user:'diego',ts:11500,time:'Aug 27 · 1:40 PM',preview:'Outbound call · 9m 30s — purchase contract executed at $214,000.',dur:'9m 30s'},

  // p7 · Gary Whitfield · 615 Lake Ridge Drive
  {id:'c21',personId:'p7',channel:'voicemail',dir:'out',party:'Gary Whitfield',user:'taylor',ts:2900,time:'Sept 2 · 9:15 AM',preview:'Voicemail left — offer expires Tuesday, asked for a callback.'},
  {id:'c22',personId:'p7',channel:'email',dir:'out',party:'Gary Whitfield',user:'taylor',ts:5800,time:'Aug 31 · 3:22 PM',preview:'Offer $188,000 — good through Tuesday Sept 9.'},

  // p8 · Linda Barnes · 388 Pine Terrace (TC record)
  {id:'c23',personId:'p8',channel:'email',dir:'in',party:'Northvale Title',user:null,ts:170,time:'Today 7:02 AM',preview:'Closing disclosure ready for review — Pine Terrace.'},
  {id:'c24',personId:'p8',channel:'sms',dir:'out',party:'Linda Barnes',user:'casey',ts:1250,time:'Yesterday 2:00 PM',preview:'Linda — final walkthrough is Thursday, funding Friday. Nothing needed from you.'},
  {id:'c25',personId:'p8',buyerId:'b1',channel:'call',dir:'out',party:'Chris Anderson · Harbor Capital',user:'casey',ts:1100,time:'Yesterday 5:40 PM',preview:'Outbound call · 2m 18s — "Wire going out first thing tomorrow." EMD still not received.',dur:'2m 18s'},
  {id:'c26',personId:'p8',channel:'email',dir:'out',party:'Linda Barnes',user:'casey',ts:7200,time:'Aug 30 · 10:00 AM',preview:'Settlement statement draft attached for your review.'},

  // p9 · Miguel Santos · 1520 Easton Avenue
  {id:'c27',personId:'p9',channel:'call',dir:'out',party:'Miguel Santos',user:'taylor',ts:1500,time:'Yesterday 10:30 AM',preview:'Outbound call · 7m 02s — 2 offers in, reviewing today.',dur:'7m 02s'},
  {id:'c28',personId:'p9',channel:'sms',dir:'in',party:'Miguel Santos',user:null,ts:2950,time:'Sept 2 · 8:40 AM',preview:'Taxes are due end of month, need this closed by the 18th.'},

  // p10 · Marvin Cole · 910 Cedar Way
  {id:'c29',personId:'p10',channel:'sms',dir:'in',party:'Marvin Cole',user:null,ts:40,time:'Today 9:10 AM',preview:'Title cleared? Movers are booked for Saturday.'},
  {id:'c30',personId:'p10',channel:'email',dir:'out',party:'Marvin Cole',user:'casey',ts:1600,time:'Yesterday 9:20 AM',preview:'Title is clear — funding Friday as planned.'},

  // p11 · Teresa Vance · 7302 Sagebrush Ct
  {id:'c31',personId:'p11',channel:'sms',dir:'in',party:'Teresa Vance',user:null,ts:300,time:'Today 7:05 AM',preview:'Not ready yet but keep me posted on values in Plano.'},
  {id:'c32',personId:'p11',channel:'call',dir:'out',party:'Teresa Vance',user:'diego',ts:4400,time:'Sept 1 · 3:15 PM',preview:'Outbound call · 4m 40s — exploring options, 6 month timeline.',dur:'4m 40s'},

  // p12 · Harold Kim · 9021 Brookhollow Dr
  {id:'c33',personId:'p12',channel:'voicemail',dir:'in',party:'Harold Kim',user:null,ts:1350,time:'Yesterday 1:05 PM',preview:'Voicemail · 0:48 — "Confirming Saturday at 10, call me back."'},
  {id:'c34',personId:'p12',channel:'call',dir:'out',party:'Harold Kim',user:'taylor',ts:1300,time:'Yesterday 2:00 PM',preview:'Outbound call · 5m 55s — walkthrough set for Saturday 10:00.',dur:'5m 55s'},

  // p13 · Denise Carter · 318 Harvest Moon
  {id:'c35',personId:'p13',channel:'call',dir:'out',party:'Denise Carter',user:'diego',ts:4300,time:'Sept 1 · 11:10 AM',preview:'Outbound call · 3m 10s — not urgent, 12 month horizon. Long-term nurture.',dur:'3m 10s'},

  // p14 · Bruce Tanner · 5518 Ridgecrest Rd
  {id:'c36',personId:'p14',channel:'call',dir:'out',party:'Bruce Tanner',user:'taylor',ts:17000,time:'Aug 23 · 2:30 PM',preview:'Outbound call · 2m 05s — listed with an agent, closing the file.',dur:'2m 05s'},
];

// TC checklists — the Acme Homes contract-to-close templates, one per deal type.
// Structure mirrors the printed checklist: milestone rail (D0 → D14), phases of
// tasks with a day target and an optional note, and the HUD/CD review block that
// gates funding. `critical` marks the orange critical path on the paper form.

// Transactions — the TC file for a deal that is under contract or closing. One
// per deal; `dealId` and `personId` both point back into the graph.
const transactions = [
  {id:'tx6',dealId:'d6',personId:'p6',escrow:'NV-2207-8841',dealType:'assignment',d0:'Aug 27',ctcTarget:'Sept 6',done:{a1:true,a2:true,a3:true,a4:true,a5:true,a6:true,a7:true,a8:true,a9:true,a10:true,a11:true,a12:true,a13:true,a14:true,a15:true,a16:true,a17:true,a18:true,a20:true,a21:true},hudDone:{},tcReview:null,signoff:null,
    titleCo:'Northvale Title',titleContact:'Maria Delgado',titlePhone:'(214) 555-0310',titleEmail:'mdelgado@northvaletitle.com',
    opened:'Aug 29',closing:'Sept 22',
    commitment:{status:'Received',received:'Sept 2',effective:'Aug 30',
      exceptions:[
        {id:'x1',ref:'Schedule B · #6',kind:'Easement',text:'Utility easement across rear alley, 10 ft. Recorded 1972. Needs survey confirmation that no structure encroaches.',severity:'warning',owner:'Northvale Title',due:'Sept 10',status:'Open'},
        {id:'x2',ref:'Schedule B · #4',kind:'Restriction',text:'Subdivision restrictive covenants, Vol. 4412 Pg. 88. Standard — no cure required.',severity:'cleared',owner:'Northvale Title',due:'Sept 2',status:'Waived'},
        {id:'x3',ref:'Schedule C · #2',kind:'Probate',text:'Affidavit of heirship required — property inherited, single heir of record.',severity:'critical',owner:'Seller',due:'Sept 8',status:'Open'},
        {id:'x4',ref:'Schedule C · #1',kind:'Tax',text:'2024 county taxes unpaid, $3,180. To be paid from seller proceeds at close.',severity:'warning',owner:'Title',due:'Sept 22',status:'At close'},
      ]},
    earnest:[
      {id:'e1',party:'Seller EMD',amount:'$2,500',holder:'Northvale Title',due:'Aug 28',received:'Aug 28',status:'Received'},
      {id:'e2',party:'Buyer EMD',amount:'$10,000',holder:'Northvale Title',due:'Sept 3',received:null,status:'Overdue'},
    ],
    deadlines:[
      {id:'dl1',k:'Option period ends',date:'Sept 5',owner:'Buyer',status:'due',note:'2 days out'},
      {id:'dl2',k:'Inspection',date:'Sept 3',owner:'Buyer',status:'met',note:'Completed, no major findings'},
      {id:'dl3',k:'Financing approval',date:'Sept 12',owner:'Buyer',status:'open',note:'Harbor Capital — cash, POF on file'},
      {id:'dl4',k:'Title objections due',date:'Sept 8',owner:'TC',status:'due',note:'Exception #6 + affidavit'},
      {id:'dl5',k:'Final walkthrough',date:'Sept 19',owner:'Buyer',status:'open',note:''},
      {id:'dl6',k:'Funding',date:'Sept 22',owner:'Buyer',status:'open',note:''},
    ],
    documents:[
      {id:'doc1',k:'Purchase contract',owner:'Acquisitions',status:'Received',due:'Aug 27'},
      {id:'doc2',k:'Assignment contract',owner:'Dispo',status:'Received',due:'Sept 2'},
      {id:'doc3',k:'Assignment addendum · seller initials p.8',owner:'Seller',status:'Outstanding',due:'Sept 5'},
      {id:'doc4',k:'Affidavit of heirship',owner:'Seller',status:'Outstanding',due:'Sept 8'},
      {id:'doc5',k:'Buyer proof of funds',owner:'Buyer',status:'Received',due:'Sept 1'},
      {id:'doc6',k:'Survey',owner:'Title',status:'Ordered',due:'Sept 10'},
      {id:'doc7',k:'Closing disclosure',owner:'Title',status:'Outstanding',due:'Sept 15'},
      {id:'doc8',k:'Settlement statement',owner:'Title',status:'Outstanding',due:'Sept 18'},
    ],
    nextActions:[
      {id:'na1',who:'Chris Anderson',role:'Buyer',what:'Wire $10,000 buyer EMD to Northvale',due:'Overdue 6h',severity:'critical'},
      {id:'na2',who:'Patricia Hale',role:'Seller',what:'Initial page 8 of the assignment addendum',due:'Due Sept 5',severity:'warning'},
      {id:'na3',who:'Patricia Hale',role:'Seller',what:'Sign affidavit of heirship for Schedule C #2',due:'Due Sept 8',severity:'critical'},
      {id:'na4',who:'Maria Delgado',role:'Title',what:'Return survey confirming no encroachment on easement #6',due:'Due Sept 10',severity:'warning'},
      {id:'na5',who:'Casey Park',role:'TC',what:'File title objection letter if #6 is not cured',due:'Due Sept 8',severity:'warning'},
    ]},
  {id:'tx8',dealId:'d8',personId:'p8',escrow:'NV-0388-7712',dealType:'assignment',d0:'Jul 2',ctcTarget:'Sept 2',done:{a1:true,a2:true,a3:true,a4:true,a5:true,a6:true,a7:true,a8:true,a9:true,a10:true,a11:true,a12:true,a13:true,a14:true,a15:true,a16:true,a17:true,a18:true,a20:true,a21:true,a22:true,a23:true,a24:true,a25:true},hudDone:{h1:true,h2:true,h3:true,h4:true,h5:true,h6:true},tcReview:'Casey Park · Sept 3',signoff:null,
    titleCo:'Northvale Title',titleContact:'Maria Delgado',titlePhone:'(214) 555-0310',titleEmail:'mdelgado@northvaletitle.com',
    opened:'Aug 12',closing:'Sept 6',
    commitment:{status:'Cleared',received:'Aug 20',effective:'Aug 16',
      exceptions:[
        {id:'x5',ref:'Schedule B · #3',kind:'Lien',text:'Contractor lien $4,200 filed 2023. Release recorded Aug 26.',severity:'cleared',owner:'Title',due:'Aug 26',status:'Cured'},
        {id:'x6',ref:'Schedule C · #1',kind:'Estate',text:'Estate deed recorded, executor authority confirmed.',severity:'cleared',owner:'Title',due:'Aug 22',status:'Cured'},
      ]},
    earnest:[
      {id:'e3',party:'Seller EMD',amount:'$2,000',holder:'Northvale Title',due:'Aug 13',received:'Aug 13',status:'Received'},
      {id:'e4',party:'Buyer EMD',amount:'$7,500',holder:'Northvale Title',due:'Sept 3',received:null,status:'Overdue'},
    ],
    deadlines:[
      {id:'dl7',k:'Option period ends',date:'Aug 20',owner:'Buyer',status:'met',note:''},
      {id:'dl8',k:'Inspection',date:'Aug 19',owner:'Buyer',status:'met',note:'Completed'},
      {id:'dl9',k:'Financing approval',date:'Aug 30',owner:'Buyer',status:'met',note:'Cash'},
      {id:'dl10',k:'Final walkthrough',date:'Sept 5',owner:'Buyer',status:'due',note:'Thursday'},
      {id:'dl11',k:'Funding',date:'Sept 6',owner:'Buyer',status:'due',note:'Friday — EMD still outstanding'},
    ],
    documents:[
      {id:'doc9',k:'Purchase contract',owner:'Acquisitions',status:'Received',due:'Jul 2'},
      {id:'doc10',k:'Assignment contract',owner:'Dispo',status:'Received',due:'Aug 14'},
      {id:'doc11',k:'Lien release',owner:'Title',status:'Received',due:'Aug 26'},
      {id:'doc12',k:'Closing disclosure',owner:'Title',status:'Received',due:'Sept 4'},
      {id:'doc13',k:'Settlement statement',owner:'Title',status:'Outstanding',due:'Sept 5'},
    ],
    nextActions:[
      {id:'na6',who:'Chris Anderson',role:'Buyer',what:'Wire $7,500 buyer EMD — closing is Friday',due:'Overdue 6h',severity:'critical'},
      {id:'na7',who:'Maria Delgado',role:'Title',what:'Release final settlement statement',due:'Due Sept 5',severity:'warning'},
      {id:'na8',who:'Linda Barnes',role:'Seller',what:'Final walkthrough access Thursday',due:'Due Sept 5',severity:'info'},
    ]},
  {id:'tx5',dealId:'d5',personId:'p5',escrow:'NV-0044-9120',dealType:'novation',d0:'Aug 22',ctcTarget:'Sept 8',done:{n1:true,n2:true,n3:true,n4:true,n5:true,n6:true,n7:true,n8:true,n9:true,n10:true,n11:true,n12:true,n13:true,n14:true},hudDone:{},tcReview:null,signoff:null,
    titleCo:'Alamo Heights Title',titleContact:'Ruben Ortiz',titlePhone:'(210) 555-0455',titleEmail:'rortiz@ahtitle.com',
    opened:'Aug 22',closing:'Sept 12',
    commitment:{status:'Pending',received:null,effective:null,
      exceptions:[
        {id:'x7',ref:'Schedule C · #1',kind:'Probate',text:'Letters testamentary received; awaiting title review before commitment issues.',severity:'warning',owner:'Title',due:'Sept 6',status:'In review'},
      ]},
    earnest:[
      {id:'e5',party:'Seller EMD',amount:'$3,000',holder:'Alamo Heights Title',due:'Aug 23',received:'Aug 23',status:'Received'},
      {id:'e6',party:'Buyer EMD',amount:'$12,000',holder:'Alamo Heights Title',due:'Sept 9',received:null,status:'Pending'},
    ],
    deadlines:[
      {id:'dl12',k:'Inspection',date:'Aug 26',owner:'Buyer',status:'met',note:'Access coordinated'},
      {id:'dl13',k:'Title commitment due',date:'Sept 6',owner:'Title',status:'due',note:'Not yet issued'},
      {id:'dl14',k:'Financing approval',date:'Sept 8',owner:'Buyer',status:'open',note:''},
      {id:'dl15',k:'Funding',date:'Sept 12',owner:'Buyer',status:'open',note:''},
    ],
    documents:[
      {id:'doc14',k:'Purchase contract',owner:'Acquisitions',status:'Received',due:'Aug 22'},
      {id:'doc15',k:'Letters testamentary',owner:'Seller',status:'Received',due:'Aug 30'},
      {id:'doc16',k:'Title commitment',owner:'Title',status:'Outstanding',due:'Sept 6'},
      {id:'doc17',k:'Assignment contract',owner:'Dispo',status:'Outstanding',due:'Sept 8'},
    ],
    nextActions:[
      {id:'na9',who:'Ruben Ortiz',role:'Title',what:'Issue title commitment — 2 days past internal target',due:'Due Sept 6',severity:'warning'},
      {id:'na10',who:'Morgan Lane',role:'Dispo',what:'Assign to a buyer — no assignment contract yet',due:'Due Sept 8',severity:'warning'},
    ]},
];

export const CLOZR_DATA = {IMG,team,STAGES,people,deals,buyers,timeline,comps,rehab,exits,propertyIntel,inbox,tasks,notifications,offers,walkthroughs,engagementFeed,tcItems,tcBlockers,tcFeed,communications,transactions,tcChecklists,actionPlans,enrollments,vendors,reporting,automation,calendar};

export type ClozrData = typeof CLOZR_DATA;
