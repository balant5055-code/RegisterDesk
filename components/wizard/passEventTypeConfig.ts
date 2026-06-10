// Config-driven pass benefits grouped by event type.
// To add a new event type: add one entry below — no component changes needed.

export interface BenefitItem {
  id:    string
  label: string
}

export interface BenefitGroup {
  id:       string
  label:    string
  benefits: BenefitItem[]
}

export interface EventTypeBenefitsConfig {
  groups: BenefitGroup[]
}

const g = (id: string, label: string, items: [string, string][]): BenefitGroup => ({
  id,
  label,
  benefits: items.map(([bid, blabel]) => ({ id: bid, label: blabel })),
})

export const PASS_BENEFITS_BY_EVENT_TYPE: Record<string, EventTypeBenefitsConfig> = {

  conference: {
    groups: [
      g('access', 'Conference Access', [
        ['conference_access', 'Conference Access'],
        ['multi_day',         'Multi-Day Access'],
        ['all_sessions',      'All Sessions'],
        ['selected_sessions', 'Selected Sessions'],
        ['workshop_access',   'Workshop Access'],
      ]),
      g('hospitality', 'Hospitality', [
        ['lunch',       'Lunch Included'],
        ['tea_snacks',  'Tea & Snacks'],
        ['dinner',      'Dinner Included'],
        ['gala_dinner', 'Gala Dinner'],
      ]),
      g('premium', 'Premium', [
        ['front_row',        'Front Row Seating'],
        ['vip_lounge',       'VIP Lounge'],
        ['speaker_meet',     'Speaker Meet & Greet'],
        ['networking_lounge','Networking Lounge'],
      ]),
      g('materials', 'Materials', [
        ['delegate_kit',   'Delegate Kit'],
        ['conference_bag', 'Conference Bag'],
        ['printed_materials','Printed Materials'],
      ]),
      g('recognition', 'Recognition', [
        ['participation_cert', 'Participation Certificate'],
        ['attendance_cert',    'Attendance Certificate'],
      ]),
    ],
  },

  exhibition: {
    groups: [
      g('visitor', 'Visitor Access', [
        ['visitor_access',   'Visitor Access'],
        ['hall_access',      'Hall Access'],
        ['business_entry',   'Business Visitor Entry'],
        ['vip_visitor',      'VIP Visitor Entry'],
      ]),
      g('booth', 'Booth Benefits', [
        ['standard_booth', 'Standard Booth'],
        ['premium_booth',  'Premium Booth'],
        ['sponsor_booth',  'Sponsor Booth'],
      ]),
      g('facilities', 'Facilities', [
        ['electricity', 'Electricity'],
        ['table',       'Table'],
        ['chairs',      'Chairs'],
        ['internet',    'Internet'],
        ['storage',     'Storage Space'],
      ]),
      g('promotion', 'Promotion', [
        ['directory_listing', 'Directory Listing'],
        ['brand_promotion',   'Brand Promotion'],
        ['digital_promo',     'Digital Promotion'],
      ]),
      g('networking', 'Networking', [
        ['buyer_seller', 'Buyer-Seller Meet'],
        ['biz_lounge',   'Business Lounge'],
      ]),
    ],
  },

  sports: {
    groups: [
      g('kit', 'Runner Kit', [
        ['bib',         'Bib Included'],
        ['timing_chip', 'Timing Chip Included'],
        ['tshirt',      'Event T-Shirt'],
        ['race_kit',    'Race Kit'],
      ]),
      g('finisher', 'Finisher Benefits', [
        ['finisher_medal', 'Finisher Medal'],
        ['e_certificate',  'E-Certificate'],
        ['trophy',         'Trophy Eligibility'],
      ]),
      g('support', 'Support', [
        ['water_stations', 'Water Stations'],
        ['medical_support','Medical Support'],
        ['refreshments',   'Refreshments'],
      ]),
      g('premium', 'Premium', [
        ['vip_start',     'VIP Start Zone'],
        ['priority_bib',  'Priority Bib Collection'],
      ]),
    ],
  },

  workshop: {
    groups: [
      g('learning', 'Learning', [
        ['workshop_access', 'Workshop Access'],
        ['training',        'Training Sessions'],
        ['live_qa',         'Live Q&A'],
        ['labs',            'Practical Labs'],
      ]),
      g('content', 'Content', [
        ['study_material',  'Study Material'],
        ['slides',          'Presentation Slides'],
        ['recording',       'Recording Access'],
      ]),
      g('certification', 'Certification', [
        ['completion_cert', 'Completion Certificate'],
        ['assessment_cert', 'Assessment Certificate'],
      ]),
      g('community', 'Community', [
        ['discussion_group', 'Discussion Group'],
        ['alumni_network',   'Alumni Network'],
        ['community_access', 'Community Access'],
      ]),
    ],
  },

  meetup: {
    groups: [
      g('networking', 'Networking', [
        ['networking_access', 'Networking Access'],
        ['matchmaking',       'Business Matchmaking'],
        ['founder_circle',    'Founder Circle'],
      ]),
      g('premium', 'Premium', [
        ['investor_access', 'Investor Access'],
        ['vip_lounge',      'VIP Lounge'],
        ['reserved_table',  'Reserved Table'],
      ]),
      g('engagement', 'Engagement', [
        ['pitch_session',    'Pitch Session'],
        ['startup_showcase', 'Startup Showcase'],
        ['panel_discussion', 'Panel Discussion Access'],
      ]),
      g('hospitality', 'Hospitality', [
        ['dinner',       'Dinner Included'],
        ['refreshments', 'Refreshments'],
      ]),
    ],
  },

  community: {
    groups: [
      g('participation', 'Participation', [
        ['event_entry',     'Event Entry'],
        ['volunteer_access','Volunteer Access'],
        ['supporter_access','Supporter Access'],
      ]),
      g('recognition', 'Recognition', [
        ['participation_cert','Participation Certificate'],
        ['volunteer_cert',    'Volunteer Certificate'],
      ]),
      g('materials', 'Materials', [
        ['awareness_kit',   'Awareness Kit'],
        ['campaign_mat',    'Campaign Materials'],
        ['event_badge',     'Event Badge'],
      ]),
      g('extras', 'Extras', [
        ['refreshments',    'Refreshments'],
        ['tshirt',          'T-Shirt'],
        ['tree_sapling',    'Tree Sapling'],
        ['donation_receipt','Donation Receipt'],
      ]),
    ],
  },
}

const DEFAULT_CONFIG: EventTypeBenefitsConfig = {
  groups: [
    g('access', 'Event Access', [
      ['entry',        'Event Entry'],
      ['session',      'Session Access'],
      ['certificate',  'Certificate'],
      ['refreshments', 'Refreshments'],
    ]),
  ],
}

export function getBenefitsConfig(eventTypeId: string | null | undefined): EventTypeBenefitsConfig {
  if (!eventTypeId) return DEFAULT_CONFIG
  return PASS_BENEFITS_BY_EVENT_TYPE[eventTypeId] ?? DEFAULT_CONFIG
}

/** Flat list of all benefit labels keyed by id — used in preview. */
export function buildBenefitLabelMap(config: EventTypeBenefitsConfig): Record<string, string> {
  const map: Record<string, string> = {}
  for (const group of config.groups) {
    for (const b of group.benefits) {
      map[b.id] = b.label
    }
  }
  return map
}
