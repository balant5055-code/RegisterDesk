// Master config: eventType × eventSubtype → pass behavior.
// Add a new subtype by adding one entry — no component changes needed.
// Falls back to the _default entry for the event type, then to DEFAULT_CONFIG.

import type { BenefitGroup } from './passEventTypeConfig'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface PassTemplate {
  name:            string
  description:     string
  type:            'paid' | 'free' | 'complimentary'
  suggestedPrice?: number
}

export interface SportDetailsConfig {
  sectionLabel:        string
  categoryLabel:       string
  categoryOptions:     string[]
  customCategoryLabel: string
  showAgeRules:        boolean
  showTeamSize?:       boolean
  teamSizeLabel?:      string
  teamSizeNote?:       string
}

export interface EventSubtypeConfig {
  label:         string
  contextTip:    string
  passNameHint:  string
  templates:     PassTemplate[]
  benefitGroups: BenefitGroup[]
  sportDetails?: SportDetailsConfig
}

// ─── Internal builders ────────────────────────────────────────────────────────

const b  = (id: string, label: string) => ({ id, label })
const bg = (id: string, label: string, ...items: { id: string; label: string }[]): BenefitGroup =>
  ({ id, label, benefits: items })

const tpl = (
  name: string,
  description: string,
  type: 'paid' | 'free' | 'complimentary',
  suggestedPrice?: number,
): PassTemplate => ({ name, description, type, suggestedPrice })

// ─── Shared benefit block builders ───────────────────────────────────────────

const confAccess = (...extra: { id: string; label: string }[]) =>
  bg('access', 'Conference Access',
    b('conference_access', 'Conference Access'),
    b('all_sessions',      'All Sessions'),
    b('workshop_access',   'Workshop Access'),
    b('selected_sessions', 'Selected Sessions'),
    ...extra,
  )

const confHospitality = () =>
  bg('hospitality', 'Hospitality',
    b('lunch',       'Lunch Included'),
    b('tea_snacks',  'Tea & Snacks'),
    b('dinner',      'Dinner Included'),
    b('gala_dinner', 'Gala Dinner'),
  )

const confPremium = (...extra: { id: string; label: string }[]) =>
  bg('premium', 'Premium',
    b('front_row',         'Front Row Seating'),
    b('vip_lounge',        'VIP Lounge'),
    b('speaker_meet',      'Speaker Meet & Greet'),
    b('networking_lounge', 'Networking Lounge'),
    ...extra,
  )

const confMaterials = () =>
  bg('materials', 'Materials',
    b('delegate_kit',      'Delegate Kit'),
    b('conference_bag',    'Conference Bag'),
    b('printed_materials', 'Printed Materials'),
  )

const confRecognition = (...extra: { id: string; label: string }[]) =>
  bg('recognition', 'Recognition',
    b('participation_cert', 'Participation Certificate'),
    b('attendance_cert',    'Attendance Certificate'),
    ...extra,
  )

// ─── CONFERENCE ───────────────────────────────────────────────────────────────

const CONFERENCE: Record<string, EventSubtypeConfig> = {
  business: {
    label: 'Business Conference',
    contextTip: 'Create delegate passes for different business tiers — Standard Delegate, Premium Delegate, and VIP Delegate with full hospitality.',
    passNameHint: 'e.g. Delegate Pass, VIP Pass, Business Pass',
    templates: [
      tpl('Standard Delegate', 'Full conference access with lunch and delegate kit', 'paid', 3999),
      tpl('VIP Delegate', 'Premium access with gala dinner, VIP lounge, and networking', 'paid', 8999),
      tpl('Sponsor Pass', 'Complimentary delegate pass for sponsors', 'complimentary'),
    ],
    benefitGroups: [
      confAccess(b('business_networking', 'Business Networking Session')),
      confHospitality(),
      confPremium(b('business_matchmaking', 'Business Matchmaking')),
      confMaterials(),
      confRecognition(),
    ],
  },

  corporate: {
    label: 'Corporate Conference',
    contextTip: 'Create team and individual passes — corporate events often have bulk team registrations and a VIP track for leadership.',
    passNameHint: 'e.g. Team Delegate, Leadership Pass, Corporate Pass',
    templates: [
      tpl('Corporate Delegate', 'Full conference access with lunch and team badge', 'paid', 4999),
      tpl('Leadership Pass', 'VIP access with premium seating and exclusive briefings', 'paid', 12999),
      tpl('Team Bundle (5)', 'Group registration for teams of 5', 'paid', 18999),
    ],
    benefitGroups: [
      confAccess(b('team_sessions', 'Team Strategy Sessions')),
      confHospitality(),
      confPremium(b('leadership_briefing', 'Leadership Briefing Access')),
      confMaterials(),
      confRecognition(),
    ],
  },

  rotary: {
    label: 'Rotary Conference',
    contextTip: 'Create member and guest passes — Rotary events have Active Members, Fellowship Members, and Guest passes with community-focused perks.',
    passNameHint: 'e.g. Member Pass, Guest Pass, Fellowship Pass',
    templates: [
      tpl('Active Member Pass', 'Full conference access for Rotary members', 'paid', 2500),
      tpl('Guest Pass', 'Conference access for invited guests', 'paid', 3000),
      tpl('Partner / Spouse Pass', 'Social events and cultural programs', 'paid', 1500),
    ],
    benefitGroups: [
      confAccess(b('fellowship_session', 'Fellowship Session')),
      confHospitality(),
      confPremium(b('rotary_networking', 'Rotary Networking Circle')),
      confMaterials(),
      confRecognition(b('rotary_service_cert', 'Rotary Service Certificate')),
    ],
  },

  summit: {
    label: 'Summit',
    contextTip: 'Create tiered summit passes — keynote-only passes, full day passes, and VIP backstage/speaker access passes.',
    passNameHint: 'e.g. Summit Pass, Keynote Pass, VIP Summit',
    templates: [
      tpl('Keynote Pass', 'Main stage keynote sessions only', 'paid', 2999),
      tpl('Full Summit Pass', 'All sessions, panels, and networking', 'paid', 6999),
      tpl('VIP Summit Pass', 'All access with speaker meet & greet and VIP dinner', 'paid', 14999),
    ],
    benefitGroups: [
      confAccess(b('keynote_access', 'Keynote Sessions'), b('panel_access', 'Panel Discussions')),
      confHospitality(),
      confPremium(b('backstage', 'Backstage Access')),
      confMaterials(),
      confRecognition(),
    ],
  },

  academic: {
    label: 'Academic Conference',
    contextTip: 'Create presenter and attendee passes — academic conferences have paper presenters, poster presenters, and general attendees.',
    passNameHint: 'e.g. Presenter Pass, Attendee Pass, Student Pass',
    templates: [
      tpl('Paper Presenter', 'Full access with presentation slot and certificate', 'paid', 3500),
      tpl('Attendee Pass', 'Full conference access with sessions and proceedings', 'paid', 2000),
      tpl('Student Pass', 'Conference access for enrolled students', 'paid', 800),
    ],
    benefitGroups: [
      confAccess(b('paper_presentation', 'Paper Presentation Slot'), b('poster_session', 'Poster Session Access')),
      confHospitality(),
      confPremium(),
      bg('publications', 'Publications', b('proceedings', 'Conference Proceedings'), b('abstract_book', 'Abstract Book')),
      confRecognition(b('presenter_cert', 'Presenter Certificate'), b('best_paper', 'Best Paper Eligibility')),
    ],
  },

  medical: {
    label: 'Medical Conference',
    contextTip: 'Create CME-eligible passes — medical conferences require credit tracking and workshop registrations per session.',
    passNameHint: 'e.g. CME Pass, Delegate Pass, Workshop Pass',
    templates: [
      tpl('CME Delegate Pass', 'Full conference with CME credit eligibility', 'paid', 5999),
      tpl('Workshop Add-On', 'Hands-on clinical workshop registration', 'paid', 2000),
      tpl('Junior Doctor Pass', 'Conference access for residents and PGs', 'paid', 1500),
    ],
    benefitGroups: [
      confAccess(b('cme_sessions', 'CME Eligible Sessions'), b('clinical_workshop', 'Clinical Workshop')),
      confHospitality(),
      confPremium(),
      confMaterials(),
      confRecognition(b('cme_certificate', 'CME Credit Certificate'), b('cme_credits', 'CME Credits')),
    ],
  },

  tech: {
    label: 'Tech Conference',
    contextTip: 'Create developer and business tracks — tech conferences typically separate hands-on workshop passes from executive track passes.',
    passNameHint: 'e.g. Developer Pass, Builder Pass, Executive Pass',
    templates: [
      tpl('Developer Pass', 'Full access with hands-on labs and hackathon entry', 'paid', 4999),
      tpl('Executive Pass', 'Business track with VIP networking and product briefings', 'paid', 9999),
      tpl('Startup Pass', 'Discounted access for early-stage startups', 'paid', 2499),
    ],
    benefitGroups: [
      confAccess(b('lab_access', 'Hands-on Lab Access'), b('hackathon', 'Hackathon Entry')),
      confHospitality(),
      confPremium(b('product_demo', 'Exclusive Product Demo Access')),
      bg('builder', 'Builder Perks', b('swag_kit', 'Conference Swag Kit'), b('cloud_credits', 'Cloud Credits')),
      confRecognition(b('builder_cert', 'Builder Certificate')),
    ],
  },

  _default: {
    label: 'Conference',
    contextTip: 'Create delegate passes for different access levels — standard, premium, and VIP delegates.',
    passNameHint: 'e.g. Delegate Pass, VIP Pass, Student Pass',
    templates: [
      tpl('Standard Delegate', 'Full conference access with lunch', 'paid', 2999),
      tpl('VIP Delegate', 'Premium access with gala dinner and VIP lounge', 'paid', 7999),
    ],
    benefitGroups: [
      confAccess(), confHospitality(), confPremium(), confMaterials(), confRecognition(),
    ],
  },
}

// ─── EXHIBITION & EXPO ────────────────────────────────────────────────────────

const EXHIBITION: Record<string, EventSubtypeConfig> = {
  trade_show: {
    label: 'Trade Show',
    contextTip: 'Create visitor and exhibitor passes — trade shows have business visitor, general visitor, and exhibitor team passes.',
    passNameHint: 'e.g. Business Visitor Pass, Exhibitor Pass, Trade Pass',
    templates: [
      tpl('General Visitor', 'Full expo hall access for general public', 'free'),
      tpl('Business Visitor', 'Dedicated business visitor entry with buyer-seller meet', 'paid', 500),
      tpl('Exhibitor Team Pass', 'Exhibitor staff access for booth management', 'paid', 1000),
    ],
    benefitGroups: [
      bg('access', 'Visitor Access', b('visitor_access', 'Visitor Access'), b('hall_access', 'Full Hall Access'), b('vip_visitor', 'VIP Visitor Entry')),
      bg('networking', 'Networking', b('buyer_seller', 'Buyer-Seller Meet'), b('biz_lounge', 'Business Lounge')),
      bg('promotion', 'Exhibitor Benefits', b('directory_listing', 'Directory Listing'), b('brand_promotion', 'Brand Promotion')),
    ],
  },

  fair: {
    label: 'Exhibition Fair',
    contextTip: 'Create general entry and family passes — fairs typically have individual, couple, and family ticket tiers.',
    passNameHint: 'e.g. General Entry, Family Pack, VIP Entry',
    templates: [
      tpl('General Entry', 'Full fair access for one person', 'paid', 200),
      tpl('Family Pack (4)', 'Fair entry for a family of four', 'paid', 600),
      tpl('VIP Entry', 'Priority entry with premium zone access', 'paid', 999),
    ],
    benefitGroups: [
      bg('access', 'Fair Access', b('visitor_access', 'Fair Entry'), b('all_stalls', 'All Stall Access'), b('cultural_shows', 'Cultural Shows')),
      bg('extras', 'Extras', b('parking', 'Complimentary Parking'), b('goodies', 'Welcome Goody Bag')),
    ],
  },

  product: {
    label: 'Product Showcase',
    contextTip: 'Create media, trade, and public passes — product showcases have invite-only media passes and general demo access passes.',
    passNameHint: 'e.g. Media Pass, Demo Pass, Partner Pass',
    templates: [
      tpl('Media Pass', 'Press and media access with product briefing', 'complimentary'),
      tpl('Trade Partner Pass', 'Exclusive hands-on access with Q&A session', 'paid', 1500),
      tpl('Public Demo Pass', 'General product demo access', 'free'),
    ],
    benefitGroups: [
      bg('access', 'Showcase Access', b('demo_access', 'Live Demo Access'), b('product_briefing', 'Product Briefing'), b('hands_on', 'Hands-on Trial')),
      bg('premium', 'Premium', b('media_kit', 'Press/Media Kit'), b('interview_slot', 'Interview Slot')),
    ],
  },

  _default: {
    label: 'Exhibition & Expo',
    contextTip: 'Create visitor and exhibitor passes — define separate passes for general visitors, business visitors, and exhibitor teams.',
    passNameHint: 'e.g. Visitor Pass, Exhibitor Pass, VIP Visitor',
    templates: [
      tpl('General Visitor', 'Full expo hall access', 'free'),
      tpl('Business Visitor', 'Business entry with networking access', 'paid', 500),
    ],
    benefitGroups: [
      bg('access', 'Visitor Access', b('visitor_access', 'Visitor Access'), b('hall_access', 'Hall Access'), b('vip_visitor', 'VIP Entry')),
      bg('facilities', 'Facilities', b('electricity', 'Electricity'), b('table', 'Table'), b('chairs', 'Chairs'), b('internet', 'Internet')),
      bg('networking', 'Networking', b('buyer_seller', 'Buyer-Seller Meet'), b('biz_lounge', 'Business Lounge')),
    ],
  },
}

// ─── SPORTS & FITNESS ─────────────────────────────────────────────────────────

const SPORTS: Record<string, EventSubtypeConfig> = {
  running: {
    label: 'Running Event',
    contextTip: 'Create separate passes per race distance — 5K, 10K, Half Marathon, and Full Marathon runners register under different passes.',
    passNameHint: 'e.g. 10K Runner Pass, Half Marathon Pass, Finisher Pack',
    templates: [
      tpl('5K Run Pass', 'Race entry with bib, timing chip, and finisher medal', 'paid', 699),
      tpl('10K Run Pass', 'Race entry with bib, timing chip, T-shirt, and medal', 'paid', 999),
      tpl('Half Marathon Pass', 'Premium entry with full runner kit and medal', 'paid', 1499),
      tpl('Full Marathon Pass', 'Elite entry with premium runner kit and trophy eligibility', 'paid', 2499),
    ],
    benefitGroups: [
      bg('kit', 'Runner Kit', b('bib', 'Bib Number'), b('timing_chip', 'Timing Chip'), b('tshirt', 'Event T-Shirt'), b('race_kit', 'Full Race Kit')),
      bg('finisher', 'Finisher Benefits', b('finisher_medal', 'Finisher Medal'), b('e_certificate', 'E-Certificate'), b('trophy', 'Trophy Eligibility')),
      bg('support', 'Race Support', b('water_stations', 'Water Stations'), b('medical_support', 'Medical Support'), b('energy_drink', 'Energy Drink')),
      bg('premium', 'Premium Perks', b('vip_start', 'VIP Start Zone'), b('priority_bib', 'Priority Bib Collection'), b('photo_service', 'Race Photo Service')),
    ],
    sportDetails: {
      sectionLabel: 'Race Details',
      categoryLabel: 'Distance / Category',
      categoryOptions: ['5K Run', '10K Run', 'Half Marathon (21K)', 'Full Marathon (42K)', 'Ultra Marathon', 'Fun Run', 'Custom'],
      customCategoryLabel: 'Custom Distance',
      showAgeRules: true,
    },
  },

  cycling: {
    label: 'Cycling Event',
    contextTip: 'Create passes per cycling distance — Gran Fondo, criterium, and time trial events need different passes with route and kit details.',
    passNameHint: 'e.g. 25K Ride Pass, Gran Fondo Pass, Elite Rider Pass',
    templates: [
      tpl('25K Ride Pass', 'Short route entry with cyclist kit', 'paid', 799),
      tpl('50K Gran Fondo Pass', 'Mid-distance entry with kit and hydration stations', 'paid', 1299),
      tpl('100K Elite Pass', 'Full distance with premium cycling kit and certificate', 'paid', 1999),
    ],
    benefitGroups: [
      bg('kit', 'Cyclist Kit', b('cycling_jersey', 'Event Cycling Jersey'), b('helmet_check', 'Helmet Safety Check'), b('race_number', 'Race Number Plate')),
      bg('route', 'Route Support', b('hydration_station', 'Hydration Stations'), b('pit_stop', 'Pit Stop Support'), b('sag_wagon', 'SAG Wagon Support')),
      bg('finisher', 'Finisher Benefits', b('finisher_medal', 'Finisher Medal'), b('e_certificate', 'E-Certificate')),
      bg('premium', 'Premium', b('vip_start', 'VIP Start Zone'), b('timing_chip', 'Timing Chip'), b('photo_service', 'Race Photo Service')),
    ],
    sportDetails: {
      sectionLabel: 'Cycling Details',
      categoryLabel: 'Distance / Route',
      categoryOptions: ['10K Circuit', '25K Ride', '50K Gran Fondo', '100K Sportive', 'Stage Race', 'Criterium', 'Custom'],
      customCategoryLabel: 'Custom Distance',
      showAgeRules: true,
    },
  },

  cricket: {
    label: 'Cricket Tournament',
    contextTip: 'Create team registration and spectator passes — cricket tournaments need team entry passes and fan zone spectator tickets.',
    passNameHint: 'e.g. Team Entry Pass, Spectator Pass, VIP Enclosure Pass',
    templates: [
      tpl('Team Entry Pass', 'Full team registration including all match slots', 'paid', 4999),
      tpl('Spectator Pass', 'Ground access for one match day', 'paid', 299),
      tpl('VIP Enclosure', 'Premium pavilion seating with hospitality', 'paid', 1999),
    ],
    benefitGroups: [
      bg('participation', 'Team Participation', b('team_registration', 'Team Registration'), b('match_access', 'Match Access'), b('practice_session', 'Practice Session Slot')),
      bg('spectator', 'Spectator Benefits', b('ground_access', 'Ground Entry'), b('pavilion', 'Pavilion Access'), b('replay_access', 'Live Score Access')),
      bg('kit', 'Player Kit', b('tshirt', 'Team T-Shirt'), b('match_ball', 'Match Ball Included'), b('stumps', 'Trophy Eligibility')),
      bg('hospitality', 'Hospitality', b('refreshments', 'Refreshments'), b('lunch', 'Lunch Included')),
    ],
    sportDetails: {
      sectionLabel: 'Match Details',
      categoryLabel: 'Match Format',
      categoryOptions: ['T20', 'T10', 'One Day (ODI)', '2-Day Match', 'Test Format', 'Custom'],
      customCategoryLabel: 'Custom Format',
      showAgeRules: false,
      showTeamSize: true,
      teamSizeLabel: 'Players per Team',
      teamSizeNote: 'e.g. 11 players per side',
    },
  },

  football: {
    label: 'Football Tournament',
    contextTip: 'Create team entry and spectator passes — football events need group-stage team passes and match-day spectator tickets.',
    passNameHint: 'e.g. Team Entry Pass, Spectator Pass, VIP Pass',
    templates: [
      tpl('Team Entry Pass', 'Full tournament registration for one team', 'paid', 3999),
      tpl('Match Day Pass', 'Spectator entry for match day', 'paid', 199),
      tpl('Season Pass', 'All-matches spectator pass for the tournament', 'paid', 999),
    ],
    benefitGroups: [
      bg('participation', 'Team Participation', b('team_entry', 'Team Registration'), b('group_stage', 'Group Stage Access'), b('knockout_access', 'Knockout Stage Access')),
      bg('spectator', 'Spectator', b('ground_access', 'Ground Entry'), b('stand_access', 'Stand Access'), b('vip_box', 'VIP Box')),
      bg('kit', 'Player Perks', b('jersey', 'Team Jersey'), b('referee', 'Referee Allocation'), b('trophy_eligibility', 'Trophy Eligibility')),
    ],
    sportDetails: {
      sectionLabel: 'Match Details',
      categoryLabel: 'Tournament Format',
      categoryOptions: ['League', 'Knockout', 'Group + Knockout', 'Friendly', '5-a-side', '7-a-side', '11-a-side', 'Custom'],
      customCategoryLabel: 'Custom Format',
      showAgeRules: true,
      showTeamSize: true,
      teamSizeLabel: 'Players per Team',
      teamSizeNote: 'e.g. 11 players per side',
    },
  },

  hockey: {
    label: 'Hockey Tournament',
    contextTip: 'Create team and spectator passes — hockey tournaments track team registrations per format (field/turf) and spectator access.',
    passNameHint: 'e.g. Team Entry, Spectator Pass, VIP Pass',
    templates: [
      tpl('Team Entry Pass', 'Full team registration for the tournament', 'paid', 4500),
      tpl('Match Spectator', 'Entry for one match day', 'paid', 150),
    ],
    benefitGroups: [
      bg('participation', 'Team Participation', b('team_entry', 'Team Registration'), b('match_access', 'Match Access')),
      bg('kit', 'Team Perks', b('jersey', 'Team Jersey'), b('equipment_check', 'Equipment Check'), b('trophy', 'Trophy Eligibility')),
    ],
    sportDetails: {
      sectionLabel: 'Match Details',
      categoryLabel: 'Tournament Format',
      categoryOptions: ['League', 'Knockout', 'Group Stage', 'Friendly', 'Custom'],
      customCategoryLabel: 'Custom Format',
      showAgeRules: true,
      showTeamSize: true,
      teamSizeLabel: 'Players per Team',
      teamSizeNote: 'e.g. 11 players per side',
    },
  },

  tennis: {
    label: 'Tennis Tournament',
    contextTip: 'Create singles, doubles, and mixed doubles passes — tennis tournaments have different entry categories per format.',
    passNameHint: 'e.g. Singles Entry, Doubles Entry, Open Category',
    templates: [
      tpl('Singles Entry', 'Individual tournament entry', 'paid', 1200),
      tpl('Doubles Entry', 'Pair registration for doubles draws', 'paid', 1800),
      tpl('Mixed Doubles Entry', 'Mixed doubles pair registration', 'paid', 1800),
    ],
    benefitGroups: [
      bg('participation', 'Participation', b('court_access', 'Court Access'), b('warm_up_slot', 'Practice/Warm-up Slot'), b('ball_kit', 'Tennis Balls Provided')),
      bg('extras', 'Perks', b('towel', 'Towel Service'), b('trophy_eligibility', 'Trophy / Medal Eligibility'), b('certificate', 'E-Certificate')),
    ],
    sportDetails: {
      sectionLabel: 'Match Details',
      categoryLabel: 'Draw / Category',
      categoryOptions: ['Singles', 'Doubles', 'Mixed Doubles', 'Veterans (35+)', 'Juniors (U-18)', 'Custom'],
      customCategoryLabel: 'Custom Category',
      showAgeRules: true,
    },
  },

  badminton: {
    label: 'Badminton Tournament',
    contextTip: 'Create passes per draw category — singles, doubles, and mixed doubles entries need to be registered separately.',
    passNameHint: 'e.g. Singles Pass, Doubles Pass, Mixed Doubles Pass',
    templates: [
      tpl('Singles Entry', 'Individual badminton tournament entry', 'paid', 800),
      tpl('Doubles Entry', 'Pair entry for doubles category', 'paid', 1200),
    ],
    benefitGroups: [
      bg('participation', 'Participation', b('court_access', 'Court Allocation'), b('shuttle_kit', 'Shuttlecocks Provided'), b('warm_up', 'Warm-up Slot')),
      bg('extras', 'Perks', b('trophy_eligibility', 'Trophy Eligibility'), b('certificate', 'Certificate')),
    ],
    sportDetails: {
      sectionLabel: 'Match Details',
      categoryLabel: 'Draw / Category',
      categoryOptions: ['Men\'s Singles', 'Women\'s Singles', 'Men\'s Doubles', 'Women\'s Doubles', 'Mixed Doubles', 'Juniors', 'Custom'],
      customCategoryLabel: 'Custom Category',
      showAgeRules: true,
    },
  },

  swimming: {
    label: 'Swimming Event',
    contextTip: 'Create passes per distance and stroke — swimming meets have different categories per distance (50m/100m/200m) and stroke type.',
    passNameHint: 'e.g. 100m Freestyle, 200m Breaststroke, Open Water',
    templates: [
      tpl('Sprint Entry (50m)', '50m event entry with lane allocation', 'paid', 500),
      tpl('Middle Distance (200m)', '200m event entry', 'paid', 600),
      tpl('Open Water 5K', 'Open water swimming event entry', 'paid', 1200),
    ],
    benefitGroups: [
      bg('participation', 'Participation', b('lane_allocation', 'Lane Allocation'), b('timing_chip', 'Timing Chip'), b('certificate', 'Swim Certificate')),
      bg('extras', 'Perks', b('towel_service', 'Towel Service'), b('medal', 'Finisher Medal')),
    ],
    sportDetails: {
      sectionLabel: 'Event Details',
      categoryLabel: 'Distance / Stroke',
      categoryOptions: ['50m Freestyle', '100m Freestyle', '200m Freestyle', '100m Breaststroke', '100m Backstroke', '100m Butterfly', '200m IM', 'Open Water 5K', 'Custom'],
      customCategoryLabel: 'Custom Event',
      showAgeRules: true,
    },
  },

  basketball: {
    label: 'Basketball Tournament',
    contextTip: 'Create team passes per format — 3×3 and 5v5 basketball need separate team entry passes with team rosters.',
    passNameHint: 'e.g. 3x3 Team Pass, 5v5 Team Pass, Spectator Pass',
    templates: [
      tpl('3×3 Team Entry', 'Team registration for 3×3 basketball format', 'paid', 1999),
      tpl('5v5 Team Entry', 'Full team registration for 5v5 tournament', 'paid', 3999),
    ],
    benefitGroups: [
      bg('participation', 'Participation', b('team_entry', 'Team Registration'), b('court_access', 'Court Access'), b('referee', 'Referee Allocation')),
      bg('extras', 'Perks', b('jersey', 'Team Jersey'), b('trophy_eligibility', 'Trophy Eligibility')),
    ],
    sportDetails: {
      sectionLabel: 'Tournament Details',
      categoryLabel: 'Format',
      categoryOptions: ['3×3 Basketball', '5v5 Basketball', 'Half Court', 'Full Court', 'Custom'],
      customCategoryLabel: 'Custom Format',
      showAgeRules: true,
      showTeamSize: true,
      teamSizeLabel: 'Players per Team',
    },
  },

  volleyball: {
    label: 'Volleyball Tournament',
    contextTip: 'Create team passes per category — indoor and beach volleyball need separate team registrations with court allocation.',
    passNameHint: 'e.g. Indoor Team Pass, Beach Volleyball Pass, Spectator Pass',
    templates: [
      tpl('Indoor Volleyball Team', 'Team registration for indoor format', 'paid', 2999),
      tpl('Beach Volleyball Pair', 'Pair registration for beach format', 'paid', 1500),
    ],
    benefitGroups: [
      bg('participation', 'Participation', b('team_entry', 'Team Registration'), b('court_allocation', 'Court Allocation'), b('ball_kit', 'Match Balls Provided')),
      bg('extras', 'Perks', b('trophy_eligibility', 'Trophy Eligibility'), b('certificate', 'Certificate')),
    ],
    sportDetails: {
      sectionLabel: 'Tournament Details',
      categoryLabel: 'Format / Category',
      categoryOptions: ['Indoor 6v6', 'Beach 2s (Pairs)', 'Mixed Indoor', 'Mixed Beach', 'Custom'],
      customCategoryLabel: 'Custom Format',
      showAgeRules: true,
      showTeamSize: true,
      teamSizeLabel: 'Players per Team',
    },
  },

  triathlon: {
    label: 'Triathlon',
    contextTip: 'Create passes per triathlon distance — Sprint, Olympic, Half Iron, and Full Iron distances each need a separate pass with race kit.',
    passNameHint: 'e.g. Sprint Triathlon Pass, Olympic Distance Pass, Full Iron Pass',
    templates: [
      tpl('Sprint Triathlon', '750m swim · 20K bike · 5K run entry', 'paid', 2499),
      tpl('Olympic Distance', '1.5K swim · 40K bike · 10K run entry', 'paid', 3999),
      tpl('Half Iron', '1.9K swim · 90K bike · 21.1K run entry', 'paid', 5999),
    ],
    benefitGroups: [
      bg('kit', 'Triathlete Kit', b('race_kit', 'Race Kit'), b('timing_chip', 'Timing Chip'), b('bib', 'Race Bib'), b('swim_cap', 'Swim Cap')),
      bg('support', 'Race Support', b('transition_zone', 'Transition Zone Access'), b('medical_support', 'Medical Support'), b('hydration', 'Hydration Stations')),
      bg('finisher', 'Finisher Benefits', b('finisher_medal', 'Finisher Medal'), b('certificate', 'Finisher Certificate'), b('tshirt', 'Finisher T-Shirt')),
    ],
    sportDetails: {
      sectionLabel: 'Race Details',
      categoryLabel: 'Triathlon Distance',
      categoryOptions: ['Sprint', 'Olympic', 'Half Iron (70.3)', 'Full Iron (140.6)', 'Super Sprint', 'Custom'],
      customCategoryLabel: 'Custom Distance',
      showAgeRules: true,
    },
  },

  _default: {
    label: 'Sports & Fitness Event',
    contextTip: 'Create participation passes per category — sports events often need separate passes per division, age group, or event format.',
    passNameHint: 'e.g. Participant Pass, Team Entry, Spectator Pass',
    templates: [
      tpl('Participant Pass', 'Individual entry for the sports event', 'paid', 999),
      tpl('Spectator Pass', 'General viewing access', 'paid', 199),
    ],
    benefitGroups: [
      bg('kit', 'Participant Kit', b('tshirt', 'Event T-Shirt'), b('bib', 'Race / Player Bib'), b('certificate', 'Certificate')),
      bg('support', 'Support', b('refreshments', 'Refreshments'), b('medical_support', 'Medical Support')),
    ],
    sportDetails: {
      sectionLabel: 'Event Details',
      categoryLabel: 'Category / Format',
      categoryOptions: ['Category A', 'Category B', 'Open', 'Custom'],
      customCategoryLabel: 'Custom Category',
      showAgeRules: true,
    },
  },
}

// ─── WORKSHOP & TRAINING ──────────────────────────────────────────────────────

const workshopBase = (extras: BenefitGroup[] = []): BenefitGroup[] => [
  bg('learning', 'Learning', b('workshop_access', 'Workshop Access'), b('live_qa', 'Live Q&A'), b('labs', 'Practical Labs')),
  bg('content', 'Content', b('study_material', 'Study Material'), b('slides', 'Presentation Slides'), b('recording', 'Recording Access')),
  ...extras,
  bg('community', 'Community', b('discussion_group', 'Discussion Group'), b('community_access', 'Community Access'), b('alumni_network', 'Alumni Network')),
]

const WORKSHOP: Record<string, EventSubtypeConfig> = {
  workshop: {
    label: 'Workshop',
    contextTip: 'Create hands-on workshop passes — workshops need limited seats per batch with clear tool/material inclusion details.',
    passNameHint: 'e.g. Workshop Participant, Beginner Pass, Advanced Pass',
    templates: [
      tpl('Standard Participant', 'Full workshop access with materials and lunch', 'paid', 1999),
      tpl('Online Access Pass', 'Live-stream access with recording', 'paid', 799),
    ],
    benefitGroups: workshopBase([bg('certification', 'Certification', b('completion_cert', 'Completion Certificate'))]),
  },

  bootcamp: {
    label: 'Bootcamp',
    contextTip: 'Create intensive bootcamp passes — bootcamps run in batches; create passes per batch with mentor access and assessment included.',
    passNameHint: 'e.g. Bootcamp Seat, Intensive Track, Weekend Bootcamp',
    templates: [
      tpl('Bootcamp Seat', 'Full intensive bootcamp with mentor access and certification', 'paid', 4999),
      tpl('Weekend Warrior Pack', '2-day bootcamp pass with meals and materials', 'paid', 2999),
    ],
    benefitGroups: [
      bg('learning', 'Learning', b('workshop_access', 'Bootcamp Access'), b('mentor_session', 'Mentor Sessions'), b('labs', 'Practical Labs'), b('live_qa', 'Live Q&A')),
      bg('content', 'Content', b('study_material', 'Study Material'), b('recording', 'Recording Access')),
      bg('certification', 'Certification', b('completion_cert', 'Completion Certificate'), b('assessment_cert', 'Assessment Certificate')),
    ],
  },

  certification: {
    label: 'Certification Course',
    contextTip: 'Create exam-prep and certification passes — offer exam-only, course-only, and full certification bundle passes.',
    passNameHint: 'e.g. Certification Bundle, Exam-Only Pass, Foundation Pass',
    templates: [
      tpl('Foundation Pass', 'Course content and exam prep material', 'paid', 5999),
      tpl('Exam-Only Voucher', 'Exam entry without course content', 'paid', 2999),
      tpl('Full Certification Bundle', 'Course + exam + certificate + mentoring', 'paid', 9999),
    ],
    benefitGroups: [
      bg('learning', 'Training', b('course_access', 'Full Course Access'), b('exam_prep', 'Exam Prep Material'), b('practice_tests', 'Practice Tests'), b('live_qa', 'Live Q&A')),
      bg('certification', 'Certification', b('exam_voucher', 'Exam Voucher'), b('cert_on_pass', 'Certificate on Pass'), b('badge', 'Digital Badge')),
      bg('support', 'Support', b('mentor_access', 'Mentor Access'), b('community_access', 'Learner Community')),
    ],
  },

  masterclass: {
    label: 'Masterclass',
    contextTip: 'Create limited-seat masterclass passes — masterclasses are exclusive with small cohorts; emphasize access to the expert.',
    passNameHint: 'e.g. Masterclass Seat, VIP Access, Live Session Pass',
    templates: [
      tpl('Masterclass Seat', 'Live masterclass with Q&A and recording access', 'paid', 3999),
      tpl('VIP Masterclass', 'Small-group session with 1-on-1 time with the expert', 'paid', 7999),
    ],
    benefitGroups: [
      bg('access', 'Access', b('live_session', 'Live Session Access'), b('live_qa', 'Expert Q&A'), b('recording', 'Recording Access')),
      bg('exclusives', 'Exclusives', b('workbook', 'Workbook / Toolkit'), b('cert', 'Masterclass Certificate'), b('community', 'Private Community Access')),
    ],
  },

  seminar: {
    label: 'Seminar',
    contextTip: 'Create general and premium seminar passes — seminars often have standard and VIP passes with front-row or networking extras.',
    passNameHint: 'e.g. Seminar Pass, Premium Seat, Online Pass',
    templates: [
      tpl('General Seminar Pass', 'Full seminar access with materials', 'paid', 1299),
      tpl('Premium Front Row', 'Front-row seating with networking lunch', 'paid', 2999),
      tpl('Online Pass', 'Live-stream access to all sessions', 'paid', 499),
    ],
    benefitGroups: workshopBase([bg('certification', 'Certification', b('cert', 'Attendance Certificate'))]),
  },

  live_training: {
    label: 'Live Training',
    contextTip: 'Create hands-on live training passes — create passes per training module or day with tool/software access included.',
    passNameHint: 'e.g. Live Training Seat, Full Day Pass, Module Pass',
    templates: [
      tpl('Full Training Day', 'Complete live training with tools and lunch', 'paid', 2999),
      tpl('Half Day Module', 'Morning or afternoon module registration', 'paid', 1499),
    ],
    benefitGroups: [
      bg('training', 'Training', b('live_session', 'Live Session Access'), b('tool_access', 'Tool / Software Access'), b('labs', 'Lab Access'), b('live_qa', 'Live Q&A')),
      bg('content', 'Content', b('study_material', 'Study Material'), b('recording', 'Recording Access')),
      bg('certification', 'Certification', b('cert', 'Training Certificate'), b('assessment', 'Assessment Included')),
    ],
  },

  _default: {
    label: 'Workshop & Training',
    contextTip: 'Create training passes with clear seat limits — include study materials, recording access, and certification in your pass descriptions.',
    passNameHint: 'e.g. Participant Pass, Online Pass, Workshop Seat',
    templates: [
      tpl('Standard Pass', 'Full workshop access with materials and certificate', 'paid', 1999),
    ],
    benefitGroups: workshopBase([bg('certification', 'Certification', b('cert', 'Completion Certificate'))]),
  },
}

// ─── BUSINESS MEETUP ──────────────────────────────────────────────────────────

const MEETUP: Record<string, EventSubtypeConfig> = {
  networking: {
    label: 'Networking Event',
    contextTip: 'Create general and premium networking passes — offer standard entry and VIP table passes with reserved seating and matchmaking.',
    passNameHint: 'e.g. Networking Pass, VIP Pass, Table Pass',
    templates: [
      tpl('General Entry', 'Open networking access', 'paid', 999),
      tpl('VIP Table Pass', 'Reserved table with business matchmaking', 'paid', 3999),
    ],
    benefitGroups: [
      bg('networking', 'Networking', b('open_networking', 'Open Networking'), b('matchmaking', 'Business Matchmaking'), b('card_exchange', 'Business Card Exchange')),
      bg('premium', 'Premium', b('reserved_table', 'Reserved Table'), b('vip_lounge', 'VIP Lounge'), b('dinner', 'Dinner Included')),
    ],
  },

  startup: {
    label: 'Startup Meetup',
    contextTip: 'Create startup and investor passes — startup meetups need pitch session access and investor match passes.',
    passNameHint: 'e.g. Startup Pass, Pitch Pass, Investor Pass',
    templates: [
      tpl('Startup Entry', 'Networking and startup showcase access', 'paid', 1499),
      tpl('Pitch Slot Pass', 'Presentation slot at the startup pitch stage', 'paid', 3999),
      tpl('Investor Access', 'VIP investor access with private meeting slots', 'complimentary'),
    ],
    benefitGroups: [
      bg('networking', 'Networking', b('startup_showcase', 'Startup Showcase'), b('open_networking', 'Open Networking'), b('matchmaking', 'Investor Matchmaking')),
      bg('engagement', 'Engagement', b('pitch_session', 'Pitch Session Access'), b('panel_discussion', 'Panel Discussion'), b('demo_table', 'Demo Table')),
      bg('premium', 'Premium', b('investor_access', 'Investor Access'), b('vip_lounge', 'VIP Lounge')),
    ],
  },

  investor: {
    label: 'Investor Meetup',
    contextTip: 'Create startup and investor passes — investor meets are invite-only; use complementary passes for investors and paid passes for startups seeking funding.',
    passNameHint: 'e.g. Startup Pitch Pass, Investor Pass, Observer Pass',
    templates: [
      tpl('Startup Pitch Pass', 'Access to pitch and 1-on-1 investor meetings', 'paid', 5999),
      tpl('Investor Access', 'Private investor entry with startup deck access', 'complimentary'),
    ],
    benefitGroups: [
      bg('engagement', 'Engagement', b('pitch_session', 'Pitch Session'), b('one_on_one', '1-on-1 Investor Meetings'), b('deck_access', 'Startup Deck Access')),
      bg('premium', 'Premium', b('vip_lounge', 'VIP Lounge'), b('reserved_table', 'Reserved Table'), b('dinner', 'Dinner Included')),
    ],
  },

  founder: {
    label: 'Founder Circle',
    contextTip: 'Create exclusive founder passes — founder circles are small, invite-only gatherings; use complimentary and curated paid passes.',
    passNameHint: 'e.g. Founder Pass, Co-Founder Pass, Guest Pass',
    templates: [
      tpl('Founder Member Pass', 'Circle membership with exclusive sessions and whiteboard', 'paid', 4999),
      tpl('Guest Pass', 'Invited guest access for one session', 'complimentary'),
    ],
    benefitGroups: [
      bg('access', 'Circle Access', b('founder_circle', 'Founder Circle Access'), b('whiteboard_session', 'Whiteboard Session'), b('exclusive_networking', 'Exclusive Networking')),
      bg('premium', 'Perks', b('reserved_seat', 'Reserved Seat'), b('dinner', 'Dinner Included'), b('1on1_connect', '1:1 Connect Session')),
    ],
  },

  corporate: {
    label: 'Corporate Meetup',
    contextTip: 'Create corporate and team passes — corporate meetups often have departmental registrations and leadership tracks.',
    passNameHint: 'e.g. Team Pass, Leadership Pass, Employee Pass',
    templates: [
      tpl('Employee Pass', 'Corporate networking access for team members', 'paid', 799),
      tpl('Leadership Pass', 'Senior leadership networking track with reserved table', 'paid', 2999),
    ],
    benefitGroups: [
      bg('access', 'Access', b('corporate_network', 'Corporate Networking'), b('panel_access', 'Panel Discussion'), b('session_access', 'All Sessions')),
      bg('premium', 'Premium', b('vip_lounge', 'VIP Lounge'), b('reserved_table', 'Reserved Table'), b('dinner', 'Dinner Included')),
    ],
  },

  alumni: {
    label: 'Alumni Meetup',
    contextTip: 'Create alumni passes by batch year — alumni events work well with batch-specific registration and general admission tiers.',
    passNameHint: 'e.g. Alumni Pass, Batch 2020 Pass, Guest Pass',
    templates: [
      tpl('Alumni Entry', 'Reunion access with networking dinner', 'paid', 1999),
      tpl('Couple Pass', 'Alumni plus partner entry with dinner', 'paid', 3499),
    ],
    benefitGroups: [
      bg('access', 'Event Access', b('reunion_access', 'Reunion Access'), b('batch_network', 'Batch Networking'), b('photo_session', 'Group Photo Session')),
      bg('hospitality', 'Hospitality', b('dinner', 'Gala Dinner'), b('refreshments', 'Welcome Refreshments')),
    ],
  },

  _default: {
    label: 'Business Meetup',
    contextTip: 'Create networking passes with clear access levels — define separate passes for general attendees and VIP participants.',
    passNameHint: 'e.g. Networking Pass, VIP Pass, Speaker Pass',
    templates: [
      tpl('General Entry', 'Open networking and panel access', 'paid', 1299),
      tpl('VIP Pass', 'Premium networking with dinner and reserved seating', 'paid', 3999),
    ],
    benefitGroups: [
      bg('networking', 'Networking', b('open_networking', 'Open Networking'), b('matchmaking', 'Business Matchmaking')),
      bg('premium', 'Premium', b('vip_lounge', 'VIP Lounge'), b('reserved_table', 'Reserved Table'), b('dinner', 'Dinner Included')),
    ],
  },
}

// ─── COMMUNITY & AWARENESS ────────────────────────────────────────────────────

const COMMUNITY: Record<string, EventSubtypeConfig> = {
  awareness: {
    label: 'Awareness Event',
    contextTip: 'Create supporter and volunteer passes — awareness events work well with free general entry and a premium supporter pass.',
    passNameHint: 'e.g. Supporter Pass, Volunteer Pass, General Entry',
    templates: [
      tpl('General Entry', 'Event access with awareness materials', 'free'),
      tpl('Supporter Pass', 'Enhanced access with awareness kit and certificate', 'paid', 200),
    ],
    benefitGroups: [
      bg('access', 'Participation', b('event_entry', 'Event Access'), b('awareness_zone', 'Awareness Zone Access')),
      bg('materials', 'Materials', b('awareness_kit', 'Awareness Kit'), b('campaign_mat', 'Campaign Materials'), b('tshirt', 'Event T-Shirt')),
      bg('recognition', 'Recognition', b('certificate', 'Participation Certificate'), b('badge', 'Digital Badge')),
    ],
  },

  ngo: {
    label: 'NGO Event',
    contextTip: 'Create donor, volunteer, and general passes — NGO events benefit from tiered donor passes that recognize contribution levels.',
    passNameHint: 'e.g. Volunteer Pass, Donor Pass, Beneficiary Pass',
    templates: [
      tpl('Volunteer Pass', 'Volunteer participation with kit and certificate', 'free'),
      tpl('Donor Pass', 'Donor recognition with receipt and premium kit', 'paid', 500),
    ],
    benefitGroups: [
      bg('access', 'Participation', b('volunteer_access', 'Volunteer Access'), b('event_entry', 'Event Entry')),
      bg('materials', 'Materials', b('volunteer_kit', 'Volunteer Kit'), b('awareness_kit', 'NGO Materials'), b('tshirt', 'Volunteer T-Shirt')),
      bg('recognition', 'Recognition', b('volunteer_cert', 'Volunteer Certificate'), b('donation_receipt', 'Donation Receipt'), b('recognition_mention', 'Public Recognition')),
    ],
  },

  volunteer: {
    label: 'Volunteer Program',
    contextTip: 'Create volunteer passes with clear activity slots — volunteers appreciate passes that confirm their role, kit, and schedule.',
    passNameHint: 'e.g. Volunteer Pass, Team Lead Pass, Co-ordinator Pass',
    templates: [
      tpl('Volunteer Pass', 'Activity access with volunteer kit and certificate', 'free'),
      tpl('Team Lead Pass', 'Leadership role with coordination access and recognition', 'free'),
    ],
    benefitGroups: [
      bg('access', 'Access', b('volunteer_access', 'Volunteer Access'), b('activity_slot', 'Activity Slot')),
      bg('materials', 'Kit', b('volunteer_kit', 'Volunteer Kit'), b('tshirt', 'Volunteer T-Shirt'), b('id_card', 'Volunteer ID Card')),
      bg('recognition', 'Recognition', b('volunteer_cert', 'Volunteer Certificate'), b('hours_log', 'Volunteer Hours Log')),
    ],
  },

  donation: {
    label: 'Donation Drive',
    contextTip: 'Create donor passes at different contribution levels — tiered donation passes (Bronze, Silver, Gold) encourage larger contributions.',
    passNameHint: 'e.g. Supporter Pass, Bronze Donor, Gold Donor',
    templates: [
      tpl('Supporter Pass', 'Donation with recognition and certificate', 'paid', 500),
      tpl('Champion Donor', 'Premium donation tier with VIP recognition', 'paid', 5000),
    ],
    benefitGroups: [
      bg('recognition', 'Recognition', b('donation_receipt', 'Donation Receipt'), b('certificate', 'Donor Certificate'), b('name_listing', 'Donor Wall Listing')),
      bg('perks', 'Donor Perks', b('awareness_kit', 'Campaign Kit'), b('tshirt', 'Donor T-Shirt'), b('vip_acknowledgment', 'VIP Acknowledgment')),
    ],
  },

  cleanup: {
    label: 'Clean-up Drive',
    contextTip: 'Create volunteer passes with activity slots — clean-up drives need clear area assignments and volunteer kit details.',
    passNameHint: 'e.g. Clean-up Volunteer, Eco Warrior Pass, Team Lead Pass',
    templates: [
      tpl('Volunteer Pass', 'Full activity access with eco kit and certificate', 'free'),
    ],
    benefitGroups: [
      bg('access', 'Access', b('activity_slot', 'Activity Zone Access'), b('volunteer_access', 'Volunteer Access')),
      bg('kit', 'Eco Kit', b('volunteer_kit', 'Eco Volunteer Kit'), b('gloves', 'Gloves & Gear'), b('tshirt', 'Volunteer T-Shirt')),
      bg('recognition', 'Recognition', b('certificate', 'Eco Warrior Certificate'), b('tree_sapling', 'Tree Sapling Gift')),
    ],
  },

  social: {
    label: 'Social Impact Event',
    contextTip: 'Create public and supporter passes — social impact events work well with a general free entry and a supporter pass with impact kit.',
    passNameHint: 'e.g. Community Pass, Impact Supporter Pass, Volunteer Pass',
    templates: [
      tpl('Community Entry', 'General access with program materials', 'free'),
      tpl('Impact Supporter', 'Supporter access with campaign kit and recognition', 'paid', 300),
    ],
    benefitGroups: [
      bg('access', 'Participation', b('event_entry', 'Event Access'), b('program_access', 'Program Access')),
      bg('materials', 'Materials', b('impact_kit', 'Impact Kit'), b('campaign_mat', 'Campaign Materials')),
      bg('recognition', 'Recognition', b('certificate', 'Participation Certificate'), b('badge', 'Social Impact Badge')),
    ],
  },

  _default: {
    label: 'Community & Awareness',
    contextTip: 'Create community passes — offer a free general entry and a supporter pass with kit and certificate for your cause.',
    passNameHint: 'e.g. Community Pass, Volunteer Pass, Supporter Pass',
    templates: [
      tpl('Community Entry', 'Event access with awareness materials', 'free'),
      tpl('Supporter Pass', 'Supporter access with kit and certificate', 'paid', 200),
    ],
    benefitGroups: [
      bg('access', 'Participation', b('event_entry', 'Event Entry'), b('volunteer_access', 'Volunteer Access')),
      bg('materials', 'Materials', b('awareness_kit', 'Awareness Kit'), b('tshirt', 'T-Shirt')),
      bg('recognition', 'Recognition', b('certificate', 'Participation Certificate'), b('donation_receipt', 'Donation Receipt')),
    ],
  },
}

// ─── CULTURAL & ENTERTAINMENT ─────────────────────────────────────────────────

const CULTURAL: Record<string, EventSubtypeConfig> = {
  concert: {
    label: 'Concert',
    contextTip: 'Create seating-zone passes for your concert — Standing, Silver, Gold, and VIP zones each need a separate pass with clear seat/area information.',
    passNameHint: 'e.g. Standing Pass, Gold Circle, VIP Backstage',
    templates: [
      tpl('Standing Pass', 'General standing zone concert access', 'paid', 999),
      tpl('Gold Circle', 'Premium seated zone with better view', 'paid', 2499),
      tpl('VIP Backstage Pass', 'Backstage access with artist meet & greet', 'paid', 7999),
    ],
    benefitGroups: [
      bg('access', 'Concert Access', b('concert_entry', 'Concert Entry'), b('seating_zone', 'Seating Zone Allocation'), b('standing_zone', 'Standing Zone')),
      bg('premium', 'Premium', b('backstage', 'Backstage Access'), b('artist_meet', 'Artist Meet & Greet'), b('vip_lounge', 'VIP Lounge')),
      bg('perks', 'Perks', b('merchandise', 'Official Merchandise'), b('photo_access', 'Photo Opportunity'), b('priority_entry', 'Priority Entry')),
    ],
  },

  festival: {
    label: 'Festival',
    contextTip: 'Create day passes and full-festival passes — multi-day festivals need single day, weekend, and full-festival access tiers.',
    passNameHint: 'e.g. Day Pass, Weekend Pass, Festival All-Access',
    templates: [
      tpl('Day Pass', 'Single day festival access', 'paid', 799),
      tpl('Weekend Pass', 'Full weekend access with camping', 'paid', 1999),
      tpl('Festival All-Access', 'All days + backstage + premium zones', 'paid', 4999),
    ],
    benefitGroups: [
      bg('access', 'Festival Access', b('day_access', 'Day Access'), b('all_stages', 'All Stages'), b('food_zone', 'Food & Beverage Zone')),
      bg('premium', 'Premium', b('backstage', 'Backstage Access'), b('vip_lounge', 'VIP Lounge'), b('artist_meet', 'Artist Meet & Greet')),
      bg('extras', 'Extras', b('camping', 'Camping Access'), b('merchandise', 'Merch Voucher'), b('priority_entry', 'Priority Entry')),
    ],
  },

  dance: {
    label: 'Dance Show',
    contextTip: 'Create audience and participation passes — dance events have performer (participant) passes and spectator (audience) passes.',
    passNameHint: 'e.g. Audience Pass, Performer Pass, VIP Seat',
    templates: [
      tpl('Audience Pass', 'Show access with assigned seating', 'paid', 399),
      tpl('Performer Registration', 'Participant entry with backstage and rehearsal access', 'paid', 799),
    ],
    benefitGroups: [
      bg('access', 'Access', b('show_entry', 'Show Entry'), b('seating', 'Assigned Seating'), b('backstage', 'Backstage Access')),
      bg('premium', 'Premium', b('front_row', 'Front Row Seating'), b('meet_greet', 'Choreographer Meet'), b('photo_op', 'Photo Opportunity')),
    ],
  },

  drama: {
    label: 'Drama / Theatre',
    contextTip: 'Create audience passes by seating zone — theatre events have stalls, balcony, and VIP reserved sections.',
    passNameHint: 'e.g. Stalls Pass, Balcony Pass, VIP Reserved',
    templates: [
      tpl('Stalls Entry', 'Ground floor seating access', 'paid', 499),
      tpl('Balcony Entry', 'Balcony seating access', 'paid', 299),
      tpl('VIP Reserved Seat', 'Premium front reserved seating', 'paid', 1299),
    ],
    benefitGroups: [
      bg('access', 'Theatre Access', b('show_entry', 'Show Entry'), b('seating_zone', 'Seating Zone'), b('program_booklet', 'Programme Booklet')),
      bg('premium', 'Premium', b('front_row', 'Front Row Reserved'), b('backstage_tour', 'Backstage Tour'), b('meet_cast', 'Cast Meet & Greet')),
    ],
  },

  dj_night: {
    label: 'DJ Night',
    contextTip: 'Create entry and table passes — DJ nights need general entry, early bird, and VIP table packages.',
    passNameHint: 'e.g. General Entry, Early Bird, VIP Table',
    templates: [
      tpl('General Entry', 'Standard entry to the event', 'paid', 499),
      tpl('Early Bird Entry', 'Discounted early bird entry', 'paid', 299),
      tpl('VIP Table (4 Pax)', 'Reserved VIP table for 4 with bottle service', 'paid', 4999),
    ],
    benefitGroups: [
      bg('access', 'Access', b('entry', 'Event Entry'), b('dance_floor', 'Dance Floor Access'), b('skip_queue', 'Priority Entry')),
      bg('premium', 'VIP Perks', b('vip_table', 'VIP Table'), b('bottle_service', 'Bottle Service'), b('vip_lounge', 'VIP Lounge')),
    ],
  },

  talent: {
    label: 'Talent Show',
    contextTip: 'Create performer and audience passes — talent shows need participant registration (with performance slot) and audience entry tickets.',
    passNameHint: 'e.g. Performer Registration, Audience Pass, Judge Access',
    templates: [
      tpl('Performer Registration', 'Performance slot with backstage access', 'paid', 599),
      tpl('Audience Entry', 'Show access with assigned seating', 'paid', 199),
    ],
    benefitGroups: [
      bg('participant', 'Performer Benefits', b('performance_slot', 'Performance Slot'), b('backstage', 'Backstage Access'), b('certificate', 'Participation Certificate')),
      bg('audience', 'Audience Benefits', b('show_entry', 'Show Entry'), b('seating', 'Assigned Seating')),
    ],
  },

  cultural: {
    label: 'Cultural Program',
    contextTip: 'Create participant and audience passes — cultural programs have performers, volunteers, and general audience passes.',
    passNameHint: 'e.g. Cultural Pass, Participant Pass, Guest Pass',
    templates: [
      tpl('General Entry', 'Cultural program access', 'free'),
      tpl('Cultural Participant', 'Performer access with backstage and certificate', 'paid', 299),
    ],
    benefitGroups: [
      bg('access', 'Access', b('show_entry', 'Program Entry'), b('cultural_kit', 'Cultural Kit'), b('seating', 'Seating Access')),
      bg('participant', 'Participant', b('backstage', 'Backstage Access'), b('costume_area', 'Costume / Prep Area'), b('certificate', 'Participation Certificate')),
    ],
  },

  _default: {
    label: 'Cultural & Entertainment',
    contextTip: 'Create tiered passes for your entertainment event — general entry, premium seating, and VIP experience packages.',
    passNameHint: 'e.g. General Entry, Premium Pass, VIP Experience',
    templates: [
      tpl('General Entry', 'Standard event access', 'paid', 499),
      tpl('Premium Pass', 'Premium zone access with perks', 'paid', 1499),
      tpl('VIP Experience', 'Full VIP access with backstage and meet & greet', 'paid', 4999),
    ],
    benefitGroups: [
      bg('access', 'Access', b('entry', 'Event Entry'), b('seating_zone', 'Seating Zone'), b('priority_entry', 'Priority Entry')),
      bg('premium', 'Premium', b('vip_lounge', 'VIP Lounge'), b('backstage', 'Backstage Access'), b('meet_greet', 'Artist / Performer Meet')),
    ],
  },
}

// ─── AWARDS & RECOGNITION ─────────────────────────────────────────────────────

const awardsBase = (): BenefitGroup[] => [
  bg('seating', 'Seating', b('vip_seating', 'VIP Seating'), b('reserved_table', 'Reserved Table'), b('front_row', 'Front Row Access')),
  bg('hospitality', 'Hospitality', b('dinner', 'Gala Dinner'), b('welcome_drinks', 'Welcome Drinks'), b('refreshments', 'Refreshments')),
  bg('recognition', 'Recognition', b('certificate', 'Certificate'), b('trophy_collection', 'Trophy Collection'), b('photo_op', 'Photo Opportunity')),
]

const AWARDS: Record<string, EventSubtypeConfig> = {
  awards_night: {
    label: 'Awards Night',
    contextTip: 'Create nominee, guest, and table passes — awards nights need nominee entry, guest tables, and VIP dinner passes.',
    passNameHint: 'e.g. Nominee Pass, Corporate Table, VIP Dinner',
    templates: [
      tpl('Nominee Pass', 'Nominated individual entry with certificate', 'complimentary'),
      tpl('Corporate Table (10)', 'Reserved dinner table for 10 with branding', 'paid', 49999),
      tpl('Guest Pass', 'Individual guest entry with gala dinner', 'paid', 3999),
    ],
    benefitGroups: [...awardsBase(), bg('extras', 'Extras', b('nominee_access', 'Nominee Zone Access'), b('stage_access', 'Stage Access'), b('exclusive_lounge', 'Exclusive Lounge'))],
  },

  recognition: {
    label: 'Recognition Ceremony',
    contextTip: 'Create awardee and guest passes — recognition ceremonies are formal; create passes for awardees, their guests, and general attendees.',
    passNameHint: 'e.g. Awardee Pass, Guest Pass, VIP Entry',
    templates: [
      tpl('Awardee Pass', 'Ceremony entry with certificate and stage access', 'complimentary'),
      tpl('Guest Pass', 'Ceremony entry with lunch and photo opportunity', 'paid', 1999),
    ],
    benefitGroups: awardsBase(),
  },

  graduation: {
    label: 'Graduation Ceremony',
    contextTip: 'Create graduate and guest passes — graduation ceremonies need graduate entry and family/guest tickets with seating allocations.',
    passNameHint: 'e.g. Graduate Pass, Parent/Guest Pass, Faculty Pass',
    templates: [
      tpl('Graduate Pass', 'Ceremony entry with gown access and certificate', 'paid', 1000),
      tpl('Guest / Family Pass', 'Ceremony seating for family members', 'paid', 500),
    ],
    benefitGroups: [
      bg('access', 'Access', b('ceremony_access', 'Ceremony Access'), b('convocation_hall', 'Convocation Hall Entry')),
      bg('extras', 'Graduate Perks', b('gown_access', 'Gown / Regalia Access'), b('certificate', 'Degree Certificate'), b('photo_op', 'Official Photo Session')),
      bg('hospitality', 'Hospitality', b('refreshments', 'Refreshments'), b('lunch', 'Lunch Included')),
    ],
  },

  felicitation: {
    label: 'Felicitation Ceremony',
    contextTip: 'Create honouree and guest passes — felicitation ceremonies are focused events; honourees get complimentary passes.',
    passNameHint: 'e.g. Honouree Pass, Guest Entry, VIP Table',
    templates: [
      tpl('Honouree Pass', 'Ceremony entry with stage and recognition', 'complimentary'),
      tpl('Guest Entry', 'General ceremony access with refreshments', 'paid', 500),
    ],
    benefitGroups: awardsBase(),
  },

  excellence: {
    label: 'Excellence Awards',
    contextTip: 'Create nominee, corporate table, and general passes — excellence awards attract corporate delegates; offer table packages.',
    passNameHint: 'e.g. Nominee Pass, Corporate Table, Individual Guest',
    templates: [
      tpl('Nominee Pass', 'Excellence award nominee entry with certificate', 'complimentary'),
      tpl('Corporate Table (8)', 'Reserved dinner table for 8 guests', 'paid', 39999),
    ],
    benefitGroups: [...awardsBase(), bg('branding', 'Branding', b('logo_on_screen', 'Logo on Ceremony Screen'), b('brochure_listing', 'Brochure Listing'))],
  },

  summit: {
    label: 'Summit Awards',
    contextTip: 'Create delegate and VIP passes — summit awards are combined with a conference; create conference + award dinner bundle passes.',
    passNameHint: 'e.g. Summit Delegate, Award Night Pass, VIP Bundle',
    templates: [
      tpl('Summit + Awards Bundle', 'Full summit access with gala dinner and awards night', 'paid', 8999),
      tpl('Awards Night Only', 'Award ceremony and gala dinner', 'paid', 3999),
    ],
    benefitGroups: [
      bg('access', 'Access', b('summit_access', 'Summit Access'), b('awards_access', 'Awards Night Access')),
      ...awardsBase(),
    ],
  },

  _default: {
    label: 'Awards & Recognition',
    contextTip: 'Create nominee and guest passes — define complimentary nominee passes and paid guest / table passes for your ceremony.',
    passNameHint: 'e.g. Nominee Pass, Guest Pass, Table Pass',
    templates: [
      tpl('Nominee Pass', 'Ceremony entry with certificate and trophy', 'complimentary'),
      tpl('Guest Pass', 'Ceremony access with dinner', 'paid', 2999),
    ],
    benefitGroups: awardsBase(),
  },
}

// ─── FUNDRAISING & CHARITY ────────────────────────────────────────────────────

const fundraisingBase = (): BenefitGroup[] => [
  bg('recognition', 'Donor Recognition', b('donation_receipt', 'Donation Receipt'), b('certificate', 'Donor Certificate'), b('name_listing', 'Donor Wall Listing')),
  bg('perks', 'Supporter Perks', b('campaign_kit', 'Campaign Kit'), b('tshirt', 'Event T-Shirt'), b('refreshments', 'Refreshments')),
]

const FUNDRAISING: Record<string, EventSubtypeConfig> = {
  charity_run: {
    label: 'Charity Run',
    contextTip: 'Create runner passes per distance — charity runs need race passes that bundle the donation into the registration fee.',
    passNameHint: 'e.g. 5K Charity Runner, 10K Charity Run, Fun Walk',
    templates: [
      tpl('Charity 5K Pass', 'Race entry with donation receipt and runner kit', 'paid', 999),
      tpl('Charity 10K Pass', 'Premium race entry with kit, medal, and receipt', 'paid', 1499),
      tpl('Fun Walk Pass', 'Walk participation with donation and kit', 'paid', 499),
    ],
    benefitGroups: [
      bg('kit', 'Runner Kit', b('bib', 'Race Bib'), b('tshirt', 'Charity T-Shirt'), b('race_kit', 'Runner Kit')),
      bg('finisher', 'Finisher Benefits', b('medal', 'Finisher Medal'), b('certificate', 'Finisher Certificate')),
      ...fundraisingBase(),
    ],
  },

  donation_drive: {
    label: 'Donation Drive',
    contextTip: 'Create tiered donor passes — donation drives work well with Bronze, Silver, and Gold donor tiers with increasing perks.',
    passNameHint: 'e.g. Bronze Donor, Silver Donor, Gold Donor',
    templates: [
      tpl('Supporter (₹500)', 'Donation with receipt and campaign kit', 'paid', 500),
      tpl('Champion (₹5,000)', 'Premium donor with VIP recognition and certificate', 'paid', 5000),
    ],
    benefitGroups: [
      ...fundraisingBase(),
      bg('premium', 'Premium Recognition', b('vip_acknowledgment', 'VIP Acknowledgment'), b('social_shoutout', 'Social Media Shoutout')),
    ],
  },

  benefit_dinner: {
    label: 'Benefit Dinner',
    contextTip: 'Create dinner table and individual seat passes — benefit dinners need table packages for corporates and individual seats for personal donors.',
    passNameHint: 'e.g. Individual Seat, Corporate Table, VIP Table',
    templates: [
      tpl('Individual Seat', 'Gala dinner seat with donation receipt', 'paid', 2500),
      tpl('Corporate Table (10)', 'Reserved table for 10 with branding and recognition', 'paid', 24999),
    ],
    benefitGroups: [
      bg('access', 'Access', b('dinner_access', 'Gala Dinner Access'), b('programme_access', 'Event Programme')),
      bg('recognition', 'Donor Recognition', b('donation_receipt', 'Donation Receipt'), b('name_listing', 'Donor Listing'), b('certificate', 'Recognition Certificate')),
    ],
  },

  gala: {
    label: 'Charity Gala Night',
    contextTip: 'Create gala night passes with clear tier pricing — charity galas need general, gold, and platinum passes with increasing donation levels.',
    passNameHint: 'e.g. General Guest, Gold Supporter, Platinum Donor',
    templates: [
      tpl('General Guest', 'Gala night access with dinner', 'paid', 3000),
      tpl('Gold Supporter', 'Premium gala access with recognition mention', 'paid', 7500),
      tpl('Platinum Donor', 'VIP table with speech recognition and trophy', 'paid', 25000),
    ],
    benefitGroups: [
      bg('access', 'Gala Access', b('dinner', 'Gala Dinner'), b('entertainment', 'Live Entertainment')),
      ...fundraisingBase(),
      bg('premium', 'VIP Perks', b('reserved_table', 'Reserved Table'), b('stage_recognition', 'Stage Recognition'), b('trophy', 'Charity Trophy')),
    ],
  },

  campaign: {
    label: 'Campaign Event',
    contextTip: 'Create participant and supporter passes — campaign events need a free general participation pass and a paid supporter pack.',
    passNameHint: 'e.g. Campaign Participant, Supporter Pass, Volunteer Pass',
    templates: [
      tpl('Campaign Participant', 'Campaign access with materials', 'free'),
      tpl('Campaign Supporter', 'Supporter pack with premium materials and certificate', 'paid', 300),
    ],
    benefitGroups: [
      bg('access', 'Campaign Access', b('event_entry', 'Campaign Event Entry'), b('activity_access', 'Activity Access')),
      bg('materials', 'Campaign Materials', b('campaign_kit', 'Campaign Kit'), b('tshirt', 'Campaign T-Shirt'), b('badge', 'Campaign Badge')),
      bg('recognition', 'Recognition', b('certificate', 'Participation Certificate'), b('social_mention', 'Social Media Mention')),
    ],
  },

  fundraiser: {
    label: 'Fundraiser',
    contextTip: 'Create donor and supporter passes — fundraisers benefit from flexible donation tiers with recognition at each level.',
    passNameHint: 'e.g. Supporter Pass, Patron Pass, Founder Donor',
    templates: [
      tpl('Supporter Pass', 'Fundraiser entry with donation receipt', 'paid', 500),
      tpl('Patron Pass', 'Premium donor access with VIP recognition', 'paid', 2500),
    ],
    benefitGroups: fundraisingBase(),
  },

  _default: {
    label: 'Fundraising & Charity',
    contextTip: 'Create donor passes at different contribution levels — bundle the donation into the pass price and include a receipt.',
    passNameHint: 'e.g. Supporter Pass, Donor Pass, Champion Pass',
    templates: [
      tpl('Supporter Pass', 'Event access with donation receipt and kit', 'paid', 500),
      tpl('Champion Donor', 'VIP donor recognition with premium kit', 'paid', 5000),
    ],
    benefitGroups: fundraisingBase(),
  },
}

// ─── CUSTOM EVENT ─────────────────────────────────────────────────────────────

const CUSTOM_CONFIG: EventSubtypeConfig = {
  label: 'Custom Event',
  contextTip: 'Build fully custom passes for your event — define any pass names, prices, and benefits that match your unique event format.',
  passNameHint: 'e.g. VIP Access, General Entry, Custom Pass',
  templates: [
    tpl('General Entry', 'Standard event access', 'paid', 999),
    tpl('VIP Access', 'Premium access with exclusive perks', 'paid', 3999),
    tpl('Complimentary Pass', 'Invited guest pass', 'complimentary'),
  ],
  benefitGroups: [
    bg('access', 'Event Access', b('general_access', 'General Access'), b('premium_access', 'Premium Access'), b('vip_access', 'VIP Access')),
    bg('extras', 'Extras', b('refreshments', 'Refreshments'), b('certificate', 'Certificate'), b('merchandise', 'Merchandise')),
  ],
}

// ─── Master config map ────────────────────────────────────────────────────────

const CONFIGS: Record<string, Record<string, EventSubtypeConfig>> = {
  conference:  CONFERENCE,
  exhibition:  EXHIBITION,
  sports:      SPORTS,
  workshop:    WORKSHOP,
  meetup:      MEETUP,
  community:   COMMUNITY,
  cultural:    CULTURAL,
  awards:      AWARDS,
  fundraising: FUNDRAISING,
}

const DEFAULT_CONFIG: EventSubtypeConfig = {
  label: 'Event',
  contextTip: 'Create passes that clearly describe what each ticket includes — pricing, access level, and any included perks.',
  passNameHint: 'e.g. General Pass, VIP Pass, Early Bird',
  templates: [
    tpl('General Pass', 'Standard event access', 'paid', 999),
    tpl('VIP Pass', 'Premium access with additional perks', 'paid', 2999),
  ],
  benefitGroups: [
    bg('access', 'Event Access', b('general_access', 'General Access'), b('vip_access', 'VIP Access')),
    bg('extras', 'Extras', b('refreshments', 'Refreshments'), b('certificate', 'Certificate')),
  ],
}

// ─── Public accessors ─────────────────────────────────────────────────────────

export function getEventSubtypeConfig(
  eventType:    string | null | undefined,
  eventSubtype: string | null | undefined,
): EventSubtypeConfig {
  if (!eventType) return DEFAULT_CONFIG
  if (eventType === 'custom') return CUSTOM_CONFIG
  const typeMap = CONFIGS[eventType]
  if (!typeMap) return DEFAULT_CONFIG
  return (
    typeMap[eventSubtype ?? '_default'] ??
    typeMap['_default']               ??
    DEFAULT_CONFIG
  )
}

export function getPassTemplates(
  eventType:    string | null | undefined,
  eventSubtype: string | null | undefined,
): PassTemplate[] {
  return getEventSubtypeConfig(eventType, eventSubtype).templates
}

export function getContextTip(
  eventType:    string | null | undefined,
  eventSubtype: string | null | undefined,
): string {
  return getEventSubtypeConfig(eventType, eventSubtype).contextTip
}
