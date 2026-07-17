// Config-driven registration form templates + default fields per eventType × eventSubtype.
// Add a new template by appending one entry to TEMPLATES — no component changes needed.

// ─── Types ────────────────────────────────────────────────────────────────────

export type FieldType =
  | 'text' | 'textarea' | 'email' | 'mobile' | 'number'
  | 'date'  | 'dropdown' | 'radio' | 'checkbox' | 'multiselect'
  | 'file'  | 'address'  | 'url'   | 'time'     | 'country'
  | 'state' | 'city'     | 'yesno'

export const FIELD_TYPES: { id: FieldType; label: string }[] = [
  { id: 'text',        label: 'Text'        },
  { id: 'textarea',    label: 'Textarea'    },
  { id: 'email',       label: 'Email'       },
  { id: 'mobile',      label: 'Mobile'      },
  { id: 'number',      label: 'Number'      },
  { id: 'date',        label: 'Date'        },
  { id: 'dropdown',    label: 'Dropdown'    },
  { id: 'radio',       label: 'Radio'       },
  { id: 'checkbox',    label: 'Checkbox'    },
  { id: 'multiselect', label: 'Multi Select'},
  { id: 'file',        label: 'File Upload' },
  { id: 'address',     label: 'Address'     },
  { id: 'url',         label: 'URL'         },
  { id: 'time',        label: 'Time'        },
  { id: 'country',     label: 'Country'     },
  { id: 'state',       label: 'State'       },
  { id: 'city',        label: 'City'        },
  { id: 'yesno',       label: 'Yes / No'   },
]

export interface FormField {
  id:               string
  label:            string
  type:             FieldType
  required:         boolean
  visible:          boolean
  placeholder:      string
  helperText:       string
  options:          string[]
  validation:       Record<string, unknown>
  section:          string
  conditionalLogic: ConditionalRule | null
  passVisibility:   'all' | string[]
}

/** A named group of fields displayed as a collapsible section on the form. */
export interface FormSection {
  id:          string
  title:       string
  description: string
  order:       number
  fields:      FormField[]
}

export interface ConditionalRule {
  id:            string
  sourceFieldId: string
  operator:      'equals' | 'not_equals' | 'contains' | 'not_contains'
               | 'greater_than' | 'less_than' | 'is_empty' | 'is_not_empty'
  value:         string
  action:        'show' | 'hide' | 'require' | 'make_optional' | 'enable' | 'disable'
  targetFieldId: string
  enabled:       boolean
}

export interface FormSettings {
  allowGuestRegistration:   boolean
  requireApproval:          boolean
  requireLogin:             boolean
  allowFileUpload:          boolean
  oneRegistrationPerEmail:  boolean
  oneRegistrationPerMobile: boolean
}

export interface TeamSettings {
  minTeamSize:      number | null
  maxTeamSize:      number | null
  captainRequired:  boolean
  teamNameRequired: boolean
}

export interface RegistrationRules {
  // Registration mode
  registrationMode:           'individual' | 'team' | 'both'
  // Limits
  limitPerEmail:              boolean
  limitPerMobile:             boolean
  maxRegistrations:           number | null
  duplicatePolicy:            'block' | 'warn' | 'allow'
  // Approval
  approvalMode:               'auto' | 'manual'
  approvalMessage:            string
  pendingMessage:             string
  // Waitlist
  waitlistEnabled:            boolean
  waitlistMode:               'auto' | 'manual'
  waitlistCapacity:           number | null
  // Login & Identity
  requireLogin:               boolean
  allowGuestRegistration:     boolean
  requireEmailVerification:   boolean
  requireMobileVerification:  boolean
  // Form behaviour
  allowFileUpload:            boolean
  // Team settings
  teamSettings:               TeamSettings
  // Submission
  afterRegistration:          'success_page' | 'redirect_url'
  redirectUrl:                string
  successMessage:             string
  confirmationMessage:        string
}

export interface RegistrationFormDraft {
  template:          string
  sections:          FormSection[]      // primary: all fields live here, organized
  fields:            FormField[]        // derived flat list kept for backward compat
  settings:          FormSettings       // legacy — kept for backward compat
  registrationRules: RegistrationRules  // primary registration control surface
  conditionalRules:  ConditionalRule[]
}

// Groups of fields that are auto-generated for a specific pass type when a
// template is applied.  Each group is matched by checking whether any pass
// name contains one of the lowercase passNameHints.
export interface PassFieldGroup {
  passNameHints: string[]
  fields:        () => FormField[]
}

export interface FormTemplateConfig {
  id:           string
  label:        string
  description:  string
  eventType:    string
  subtypes:     string[]
  fields:       () => FormField[]
  sections?:    () => FormSection[]   // preferred over fields() when present
  defaultRules: ConditionalRule[]
  passGroups?:  PassFieldGroup[]
}

// ─── ID generators ────────────────────────────────────────────────────────────

export const makeFieldId   = (): string => 'f_'   + Math.random().toString(36).slice(2, 10)
export const makeRuleId    = (): string => 'r_'   + Math.random().toString(36).slice(2, 10)
export const makeSectionId = (): string => 'sec_' + Math.random().toString(36).slice(2, 10)

// ─── Field builder helpers ────────────────────────────────────────────────────

const f = (
  label:    string,
  type:     FieldType,
  required = true,
  opts:     Partial<Omit<FormField, 'id'>> = {},
): FormField => ({
  id: makeFieldId(), label, type, required,
  visible: true, placeholder: '', helperText: '', options: [],
  validation: {}, section: 'basic', conditionalLogic: null, passVisibility: 'all',
  ...opts,
})

const fOpt = (label: string, type: FieldType, opts?: Partial<Omit<FormField, 'id'>>) =>
  f(label, type, false, opts)

// ─── Shared field group builders ──────────────────────────────────────────────

const core = (): FormField[] => [
  f   ('Full Name',     'text'),
  f   ('Email Address', 'email'),
  f   ('Mobile Number', 'mobile'),
]

const org = (): FormField[] => [
  f('Organisation / Company', 'text'),
  f('Designation',            'text'),
]

const gst = (): FormField[] => [
  fOpt('GST / Invoice Required', 'yesno'),
  fOpt('GST Number',             'text',  { section: 'billing' }),
]

const diet  = (): FormField => fOpt('Dietary Preference', 'dropdown', {
  options:    ['Vegetarian', 'Non-Vegetarian', 'Vegan', 'Jain', 'Other'],
  helperText: 'Required for meal planning',
})

const tshirt = (): FormField => fOpt('T-Shirt Size', 'dropdown', {
  options: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
})

const blood = (): FormField => fOpt('Blood Group', 'dropdown', {
  options: ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'],
})

const sportsCore = (): FormField[] => [
  fOpt('Date of Birth',          'date',     { helperText: 'Required for age-category validation' }),
  fOpt('Gender',                 'radio',    { options: ['Male', 'Female', 'Other / Prefer not to say'] }),
  blood(),
  tshirt(),
  f   ('Emergency Contact Name',   'text'),
  f   ('Emergency Contact Number', 'mobile'),
  fOpt('Medical Conditions / Allergies', 'textarea', { helperText: 'Optional — share any conditions the medical team should know' }),
  f   ('Medical Consent', 'checkbox', true, { options: ['I confirm I am medically fit to participate in this event'] }),
  f   ('Sports Waiver',   'checkbox', true, { options: ['I have read and agree to the event waiver and release of liability'] }),
]

// ─── Event-type field set builders ────────────────────────────────────────────

const confFields   = (x: FormField[] = []): FormField[] =>
  [...core(), ...org(), fOpt('City', 'city'),
   fOpt('Attendee Type', 'dropdown', { options: ['Delegate', 'Speaker', 'Sponsor', 'VIP', 'Press / Media', 'Student'] }),
   diet(), ...x, ...gst()]

const sportsFields = (x: FormField[] = []): FormField[] =>
  [...core(), ...sportsCore(), ...x]

const wsFields     = (x: FormField[] = []): FormField[] =>
  [...core(), ...org(),
   fOpt('Experience Level', 'dropdown', { options: ['Beginner', 'Intermediate', 'Advanced', 'Expert'] }),
   fOpt('Skill Area / Focus', 'text'),
   fOpt('Laptop Required', 'yesno'), ...x]

const expoFields   = (x: FormField[] = []): FormField[] =>
  [...core(), ...org(),
   fOpt('Visitor Type', 'dropdown', { options: ['Buyer', 'Seller', 'Visitor', 'Exhibitor', 'Media', 'Investor'] }),
   fOpt('Area of Interest', 'multiselect', { options: ['Technology', 'Manufacturing', 'Healthcare', 'Education', 'Retail', 'Finance', 'Other'] }),
   ...gst(), ...x]

const meetupFields = (x: FormField[] = []): FormField[] =>
  [...core(), ...org(),
   fOpt('Role', 'dropdown', { options: ['Founder / Co-Founder', 'Investor', 'Buyer', 'Seller', 'Executive', 'Professional', 'Other'] }),
   fOpt('Interest Area', 'multiselect', { options: ['Networking', 'Investment', 'Collaboration', 'Mentorship', 'Sales', 'Hiring'] }),
   fOpt('LinkedIn Profile', 'url', { placeholder: 'https://linkedin.com/in/...' }), ...x]

const commFields   = (x: FormField[] = []): FormField[] =>
  [...core(),
   fOpt('Organisation / NGO', 'text'),
   fOpt('Volunteer / Participant Type', 'radio', { options: ['Volunteer', 'Donor', 'Participant', 'Organiser'] }),
   fOpt('Preferred Area', 'dropdown', { options: ['Education', 'Healthcare', 'Environment', 'Community', 'Other'] }),
   tshirt(), fOpt('Donation Receipt Required', 'yesno'), ...x]

const cultFields   = (x: FormField[] = []): FormField[] =>
  [...core(),
   fOpt('Group / Performer Name', 'text'),
   fOpt('Participation Type', 'radio', { options: ['Solo', 'Group', 'Institutional'] }),
   fOpt('Age Group', 'dropdown', { options: ['Under 12', '12 – 18', '18 – 30', '30 – 50', '50+'] }), ...x]

const awardFields  = (x: FormField[] = []): FormField[] =>
  [...core(), ...org(),
   fOpt('Category', 'dropdown', { options: ['Nominee', 'Guest', 'Delegate', 'Judge', 'Sponsor', 'VIP'] }),
   diet(), ...gst(), ...x]

const fundFields   = (x: FormField[] = []): FormField[] =>
  [...core(),
   fOpt('Organisation', 'text'),
   fOpt('Donor Type', 'radio', { options: ['Individual', 'Corporate', 'Anonymous'] }),
   fOpt('Donation Amount (₹)', 'number', { placeholder: 'Enter amount' }),
   fOpt('Donation Receipt Required', 'yesno'), ...x]

// ─── Section builder helper ────────────────────────────────────────────────────

const makeSection = (
  title:  string,
  fields: FormField[],
  order:  number,
  desc  = '',
): FormSection => ({ id: makeSectionId(), title, description: desc, order, fields })

// ─── Event-type section builders ──────────────────────────────────────────────

const confSections = (profExtra: FormField[] = []): FormSection[] => [
  makeSection('Personal Information',    [...core(), fOpt('City', 'city')], 0),
  makeSection('Professional Information',[...org(), fOpt('Attendee Type', 'dropdown', { options: ['Delegate', 'Speaker', 'Sponsor', 'VIP', 'Press / Media', 'Student'] }), ...profExtra], 1),
  makeSection('Event Preferences',       [diet()], 2),
  makeSection('Terms & Consent',         [...gst()], 3),
]

const sportsSections = (raceExtra: FormField[] = []): FormSection[] => [
  makeSection('Personal Information', [
    ...core(),
    fOpt('Date of Birth', 'date',  { helperText: 'Required for age-category validation' }),
    fOpt('Gender',        'radio', { options: ['Male', 'Female', 'Other / Prefer not to say'] }),
  ], 0),
  makeSection('Runner / Team Information', [...raceExtra], 1),
  makeSection('Medical Information', [
    blood(),
    tshirt(),
    f   ('Emergency Contact Name',   'text'),
    f   ('Emergency Contact Number', 'mobile'),
    fOpt('Medical Conditions / Allergies', 'textarea', { helperText: 'Optional — share any conditions the medical team should know' }),
  ], 2),
  makeSection('Terms & Consent', [
    f('Medical Consent', 'checkbox', true, { options: ['I confirm I am medically fit to participate in this event'] }),
    f('Sports Waiver',   'checkbox', true, { options: ['I have read and agree to the event waiver and release of liability'] }),
  ], 3),
]

// Same structure as sportsSections but "Runner / Team Information" → "Team Information"
const teamSportSections = (teamExtra: FormField[] = []): FormSection[] => [
  makeSection('Personal Information', [
    ...core(),
    fOpt('Date of Birth', 'date',  { helperText: 'Required for age-category validation' }),
    fOpt('Gender',        'radio', { options: ['Male', 'Female', 'Other / Prefer not to say'] }),
  ], 0),
  makeSection('Team Information', [...teamExtra], 1),
  makeSection('Medical Information', [
    blood(),
    tshirt(),
    f   ('Emergency Contact Name',   'text'),
    f   ('Emergency Contact Number', 'mobile'),
    fOpt('Medical Conditions / Allergies', 'textarea', { helperText: 'Optional — share any conditions the medical team should know' }),
  ], 2),
  makeSection('Terms & Consent', [
    f('Medical Consent', 'checkbox', true, { options: ['I confirm I am medically fit to participate in this event'] }),
    f('Sports Waiver',   'checkbox', true, { options: ['I have read and agree to the event waiver and release of liability'] }),
  ], 3),
]

const wsSections = (learningExtra: FormField[] = []): FormSection[] => [
  makeSection('Personal Information',    core(), 0),
  makeSection('Professional Information',[...org(), fOpt('Experience Level', 'dropdown', { options: ['Beginner', 'Intermediate', 'Advanced', 'Expert'] })], 1),
  makeSection('Learning Preferences',    [fOpt('Skill Area / Focus', 'text'), fOpt('Laptop Required', 'yesno'), ...learningExtra], 2),
  makeSection('Terms & Consent',         [], 3),
]

const expoSections = (companyExtra: FormField[] = []): FormSection[] => [
  makeSection('Contact Person',     core(), 0),
  makeSection('Company Information',[...org(), fOpt('Visitor Type', 'dropdown', { options: ['Buyer', 'Seller', 'Visitor', 'Exhibitor', 'Media', 'Investor'] }), fOpt('Area of Interest', 'multiselect', { options: ['Technology', 'Manufacturing', 'Healthcare', 'Education', 'Retail', 'Finance', 'Other'] }), ...companyExtra], 1),
  makeSection('Terms & Consent',    [...gst()], 2),
]

// Exhibition MVP sections — clean structure for trade shows / startup expos.
// Company Name is optional in the base form; server enforces required for Exhibitor/Sponsor passes.
const exhibitionSections = (extra: FormField[] = []): FormSection[] => [
  makeSection('Contact Person',        core(), 0),
  makeSection('Professional Details',  [
    fOpt('Company Name',     'text',     { helperText: 'Required for Exhibitor and Sponsor passes' }),
    fOpt('Designation',      'text'),
    fOpt('Company Website',  'url',      { placeholder: 'https://example.com' }),
    fOpt('Industry',         'dropdown', { options: ['Technology', 'Healthcare', 'Manufacturing', 'Education', 'Finance', 'Retail', 'Real Estate', 'Automotive', 'Media & Entertainment', 'FMCG', 'Energy', 'Other'] }),
    ...extra,
  ], 1),
  makeSection('Terms & Consent',       [], 2),
]

const meetupSections = (profileExtra: FormField[] = []): FormSection[] => [
  makeSection('Personal Information',   core(), 0),
  makeSection('Business Profile',       [...org(), fOpt('Role', 'dropdown', { options: ['Founder / Co-Founder', 'Investor', 'Buyer', 'Seller', 'Executive', 'Professional', 'Other'] }), ...profileExtra], 1),
  makeSection('Networking Preferences', [fOpt('Interest Area', 'multiselect', { options: ['Networking', 'Investment', 'Collaboration', 'Mentorship', 'Sales', 'Hiring'] }), fOpt('LinkedIn Profile', 'url', { placeholder: 'https://linkedin.com/in/...' })], 2),
  makeSection('Terms & Consent',        [], 3),
]

const commSections = (partExtra: FormField[] = []): FormSection[] => [
  makeSection('Personal Information',  core(), 0),
  makeSection('Volunteer Information', [fOpt('Organisation / NGO', 'text'), fOpt('Volunteer / Participant Type', 'radio', { options: ['Volunteer', 'Donor', 'Participant', 'Organiser'] }), fOpt('Preferred Area', 'dropdown', { options: ['Education', 'Healthcare', 'Environment', 'Community', 'Other'] })], 1),
  makeSection('Participation Details', [tshirt(), ...partExtra, fOpt('Donation Receipt Required', 'yesno')], 2),
  makeSection('Terms & Consent',       [], 3),
]

const cultSections = (perfExtra: FormField[] = []): FormSection[] => [
  makeSection('Participant Information', [...core(), fOpt('Group / Performer Name', 'text')], 0),
  makeSection('Performance Details',     [fOpt('Participation Type', 'radio', { options: ['Solo', 'Group', 'Institutional'] }), fOpt('Age Group', 'dropdown', { options: ['Under 12', '12 – 18', '18 – 30', '30 – 50', '50+'] }), ...perfExtra], 1),
  makeSection('Terms & Consent',         [], 2),
]

const awardSections = (contactExtra: FormField[] = []): FormSection[] => [
  makeSection('Nominee Information',  [...core(), fOpt('Category', 'dropdown', { options: ['Nominee', 'Guest', 'Delegate', 'Judge', 'Sponsor', 'VIP'] })], 0),
  makeSection('Organization Details', [...org()], 1),
  makeSection('Contact Information',  [...contactExtra], 2),
  makeSection('Terms & Consent',      [diet(), ...gst()], 3),
]

const fundSections = (contribExtra: FormField[] = []): FormSection[] => [
  makeSection('Donor Information',    [...core(), fOpt('Organisation', 'text'), fOpt('Donor Type', 'radio', { options: ['Individual', 'Corporate', 'Anonymous'] })], 0),
  makeSection('Contribution Details', [fOpt('Donation Amount (₹)', 'number', { placeholder: 'Enter amount' }), ...contribExtra], 1),
  makeSection('Terms & Consent',      [fOpt('Donation Receipt Required', 'yesno')], 2),
]

// ─── Pass field groups (auto-matched when template is applied with passes) ─────

const CONF_PASS_GROUPS: PassFieldGroup[] = [
  {
    // Dietary Preference is already in confSections() base — only add VIP-exclusive fields
    passNameHints: ['vip'],
    fields: () => [
      fOpt('Hotel Accommodation Required', 'yesno'),
      fOpt('Gala Dinner Attendance',       'yesno'),
    ],
  },
  {
    // Organisation / Designation are in confSections() base for all attendees.
    // Add only delegate-specific preferences not present in the base template.
    passNameHints: ['delegate'],
    fields: () => [
      fOpt('Session Preference', 'multiselect', {
        options:    ['Morning Session', 'Afternoon Session', 'Full Day', 'Workshop Only'],
        helperText: 'Select the sessions you plan to attend',
      }),
    ],
  },
  {
    // College Name and Student ID are NOT in the base conference template — keep as-is
    passNameHints: ['student'],
    fields: () => [
      f   ('College Name', 'text'),
      fOpt('Student ID',   'text'),
    ],
  },
]

const EXPO_PASS_GROUPS: PassFieldGroup[] = [
  {
    passNameHints: ['visitor', 'general'],
    fields: () => [f('Company Name', 'text')],
  },
  {
    passNameHints: ['exhibitor', 'vendor', 'seller'],
    fields: () => [
      f   ('Company Name',     'text'),
      fOpt('GST Number',       'text',        { section: 'billing' }),
      fOpt('Product Category', 'multiselect', { options: ['Technology', 'Healthcare', 'FMCG', 'Industrial', 'Education', 'Other'] }),
    ],
  },
  {
    passNameHints: ['booth'],
    fields: () => [
      f   ('Booth Requirements',   'textarea'),
      fOpt('Electricity Required', 'yesno'),
    ],
  },
]

// Pass groups for Exhibition MVP (Visitor / Exhibitor / Sponsor / Media / VIP)
const EXHIBITION_PASS_GROUPS: PassFieldGroup[] = [
  {
    // Exhibitor and Sponsor passes require Company Name — server enforces this on submit
    passNameHints: ['exhibitor', 'sponsor'],
    fields: () => [
      fOpt('GST Number',       'text',        { section: 'billing', helperText: 'Optional — for GST invoice' }),
      fOpt('Product Category', 'multiselect', { options: ['Technology', 'Healthcare', 'FMCG', 'Industrial', 'Education', 'Other'] }),
    ],
  },
  {
    passNameHints: ['media'],
    fields: () => [
      fOpt('Publication / Channel', 'text', { helperText: 'Name of your media organization' }),
    ],
  },
]

const SPORTS_RUN_PASS_GROUPS: PassFieldGroup[] = [
  {
    passNameHints: ['5k', '5 km', 'fun run', 'fun'],
    fields: () => [tshirt()],
  },
  {
    passNameHints: ['10k', '10 km'],
    fields: () => [
      tshirt(),
      fOpt('Emergency Contact Name',   'text'),
      fOpt('Emergency Contact Number', 'mobile'),
    ],
  },
  {
    passNameHints: ['half', '21k', '21 km', 'half marathon'],
    fields: () => [
      tshirt(),
      blood(),
      fOpt('Medical Declaration', 'checkbox', { options: ['I confirm I am medically fit to participate in this event'] }),
    ],
  },
  {
    passNameHints: ['full', '42k', '42 km', 'full marathon', 'marathon'],
    fields: () => [
      tshirt(),
      blood(),
      fOpt('Emergency Contact Name',   'text'),
      fOpt('Emergency Contact Number', 'mobile'),
      fOpt('Medical Declaration', 'checkbox', { options: ['I confirm I am medically fit to participate in this event'] }),
    ],
  },
]

// Pass group for team-sport player/entry passes — adds jersey number only for
// passes whose name contains 'team', 'player', 'entry', or 'participant'.
const SPORTS_TEAM_PASS_GROUPS: PassFieldGroup[] = [
  {
    passNameHints: ['team', 'player', 'entry', 'participant'],
    fields: () => [
      fOpt('Jersey Number', 'number', { helperText: 'Optional — required for registered play' }),
    ],
  },
]

// ─── Template registry ────────────────────────────────────────────────────────

const TEMPLATES: FormTemplateConfig[] = [
  // ── Conference ────────────────────────────────────────────────────────────────
  { id: 'conf_business',   label: 'Business Conference',    description: 'Delegate, VIP and speaker registration',      eventType: 'conference', subtypes: ['business', 'corporate'],          fields: () => confFields(),  sections: () => confSections(),  defaultRules: [], passGroups: CONF_PASS_GROUPS },
  { id: 'conf_rotary',     label: 'Rotary Conference',      description: 'Member, guest and partner registration',      eventType: 'conference', subtypes: ['rotary'],                         fields: () => confFields([fOpt('Rotary Club / District', 'text')]), sections: () => confSections([fOpt('Rotary Club / District', 'text')]), defaultRules: [], passGroups: CONF_PASS_GROUPS },
  { id: 'conf_summit',     label: 'Summit',                 description: 'Keynote pass and VIP registration',           eventType: 'conference', subtypes: ['summit'],                         fields: () => confFields(),  sections: () => confSections(),  defaultRules: [], passGroups: CONF_PASS_GROUPS },
  { id: 'conf_academic',   label: 'Academic Conference',    description: 'Presenter and attendee registration',         eventType: 'conference', subtypes: ['academic'],                       fields: () => confFields([fOpt('Paper Title / Poster', 'text'), fOpt('Presenter Type', 'radio', { options: ['Paper Presenter', 'Poster Presenter', 'General Attendee'] })]), sections: () => confSections([fOpt('Paper Title / Poster', 'text'), fOpt('Presenter Type', 'radio', { options: ['Paper Presenter', 'Poster Presenter', 'General Attendee'] })]), defaultRules: [], passGroups: CONF_PASS_GROUPS },
  { id: 'conf_medical',    label: 'Medical Conference',     description: 'CME delegate and workshop registration',      eventType: 'conference', subtypes: ['medical'],                        fields: () => confFields([fOpt('Specialty / Department', 'text'), fOpt('Registration Type', 'radio', { options: ['CME Delegate', 'Workshop Only', 'Speaker', 'Sponsor'] })]), sections: () => confSections([fOpt('Specialty / Department', 'text'), fOpt('Registration Type', 'radio', { options: ['CME Delegate', 'Workshop Only', 'Speaker', 'Sponsor'] })]), defaultRules: [], passGroups: CONF_PASS_GROUPS },
  { id: 'conf_tech',       label: 'Tech Conference',        description: 'Developer, speaker and attendee form',        eventType: 'conference', subtypes: ['tech', 'technology'],             fields: () => confFields([fOpt('GitHub / Portfolio URL', 'url'), fOpt('Tech Focus Area', 'multiselect', { options: ['Web', 'Mobile', 'AI/ML', 'DevOps', 'Cloud', 'Security', 'Blockchain'] })]), sections: () => confSections([fOpt('GitHub / Portfolio URL', 'url'), fOpt('Tech Focus Area', 'multiselect', { options: ['Web', 'Mobile', 'AI/ML', 'DevOps', 'Cloud', 'Security', 'Blockchain'] })]), defaultRules: [], passGroups: CONF_PASS_GROUPS },
  { id: 'conf_default',    label: 'Conference Registration',description: 'Standard conference registration form',       eventType: 'conference', subtypes: [],                                 fields: () => confFields(),  sections: () => confSections(),  defaultRules: [], passGroups: CONF_PASS_GROUPS },

  // ── Exhibition ────────────────────────────────────────────────────────────────
  { id: 'expo_tradeshow',  label: 'Trade Show',             description: 'Buyer and seller registration',               eventType: 'exhibition', subtypes: ['tradeshow', 'trade_show'],                    fields: () => expoFields(), sections: () => expoSections(),  defaultRules: [], passGroups: EXPO_PASS_GROUPS },
  { id: 'expo_visitor',    label: 'Expo Visitor',           description: 'General visitor and buyer form',              eventType: 'exhibition', subtypes: ['fair', 'product', 'auto', 'education', 'property'], fields: () => expoFields(), sections: () => expoSections(),  defaultRules: [], passGroups: EXPO_PASS_GROUPS },
  { id: 'expo_exhibitor',  label: 'Exhibitor Registration', description: 'Booth and exhibitor details form',            eventType: 'exhibition', subtypes: ['exhibitor'],                                    fields: () => expoFields([fOpt('Booth Number / Size', 'text'), fOpt('Product Category', 'multiselect', { options: ['Technology', 'Healthcare', 'FMCG', 'Industrial', 'Education', 'Other'] })]), sections: () => expoSections([fOpt('Booth Number / Size', 'text'), fOpt('Product Category', 'multiselect', { options: ['Technology', 'Healthcare', 'FMCG', 'Industrial', 'Education', 'Other'] })]), defaultRules: [], passGroups: EXPO_PASS_GROUPS },
  { id: 'expo_default',    label: 'Exhibition Registration',description: 'Standard exhibition registration form',       eventType: 'exhibition', subtypes: [],                                              fields: () => expoFields(), sections: () => expoSections(),  defaultRules: [], passGroups: EXPO_PASS_GROUPS },
  // Exhibition MVP — supports Visitor / Exhibitor / Sponsor / Media / VIP pass types
  { id: 'exhibition_mvp',  label: 'Exhibition (Visitor · Exhibitor · Sponsor · Media · VIP)', description: 'Full-featured exhibition form for trade shows and expos', eventType: 'exhibition', subtypes: ['startup', 'business', 'tech', 'art', 'health', 'food', 'design', 'gaming', 'automobile'], fields: () => [...core(), fOpt('Company Name', 'text'), fOpt('Designation', 'text'), fOpt('Company Website', 'url', { placeholder: 'https://example.com' }), fOpt('Industry', 'dropdown', { options: ['Technology', 'Healthcare', 'Manufacturing', 'Education', 'Finance', 'Retail', 'Real Estate', 'Automotive', 'Media & Entertainment', 'FMCG', 'Energy', 'Other'] })], sections: () => exhibitionSections(), defaultRules: [], passGroups: EXHIBITION_PASS_GROUPS },

  // ── Sports ────────────────────────────────────────────────────────────────────
  { id: 'sports_run',      label: 'Running Registration',   description: 'Marathon, 5K and fun run registration',      eventType: 'sports', subtypes: ['marathon', 'running', 'run'],       fields: () => sportsFields([fOpt('Running Category', 'dropdown', { options: ['5K', '10K', 'Half Marathon (21K)', 'Full Marathon (42K)', 'Ultra Marathon', 'Fun Run'] })]), sections: () => sportsSections([fOpt('Running Category', 'dropdown', { options: ['5K', '10K', 'Half Marathon (21K)', 'Full Marathon (42K)', 'Ultra Marathon', 'Fun Run'] })]), defaultRules: [], passGroups: SPORTS_RUN_PASS_GROUPS },
  { id: 'sports_cycling',  label: 'Cycling Registration',   description: 'Cycling race and gran fondo form',           eventType: 'sports', subtypes: ['cycling'],                         fields: () => sportsFields([fOpt('Ride Category', 'dropdown', { options: ['10K Circuit', '25K', '50K Gran Fondo', '100K Sportive', 'Stage Race', 'Criterium'] })]),                  sections: () => sportsSections([fOpt('Ride Category', 'dropdown', { options: ['10K Circuit', '25K', '50K Gran Fondo', '100K Sportive', 'Stage Race', 'Criterium'] })]),                  defaultRules: [] },
  { id: 'sports_cricket',  label: 'Cricket Registration',   description: 'Team and player registration',               eventType: 'sports', subtypes: ['cricket'],                         fields: () => sportsFields([fOpt('Team Name', 'text'), fOpt('Player Role', 'dropdown', { options: ['Batsman', 'Bowler', 'All-Rounder', 'Wicket-Keeper', 'Captain'] })]),                 sections: () => sportsSections([fOpt('Team Name', 'text'), fOpt('Player Role', 'dropdown', { options: ['Batsman', 'Bowler', 'All-Rounder', 'Wicket-Keeper', 'Captain'] })]),                 defaultRules: [] },
  { id: 'sports_football', label: 'Football Registration',  description: 'Team and player registration',               eventType: 'sports', subtypes: ['football', 'soccer'],              fields: () => sportsFields([fOpt('Team Name', 'text'), fOpt('Position', 'dropdown', { options: ['Goalkeeper', 'Defender', 'Midfielder', 'Striker', 'Any / Open'] })]),                    sections: () => sportsSections([fOpt('Team Name', 'text'), fOpt('Position', 'dropdown', { options: ['Goalkeeper', 'Defender', 'Midfielder', 'Striker', 'Any / Open'] })]),                    defaultRules: [] },
  { id: 'sports_tennis',   label: 'Tennis Registration',    description: 'Tennis tournament registration',             eventType: 'sports', subtypes: ['tennis'],                          fields: () => sportsFields([fOpt('Play Category', 'radio', { options: ['Singles', 'Doubles', 'Mixed Doubles', 'Veterans', 'Juniors'] })]),                                               sections: () => sportsSections([fOpt('Play Category', 'radio', { options: ['Singles', 'Doubles', 'Mixed Doubles', 'Veterans', 'Juniors'] })]),                                               defaultRules: [] },
  { id: 'sports_badminton',label: 'Badminton Registration', description: 'Badminton tournament form',                  eventType: 'sports', subtypes: ['badminton'],                       fields: () => sportsFields([fOpt('Play Category', 'radio', { options: ["Men's Singles", "Women's Singles", "Men's Doubles", "Women's Doubles", 'Mixed Doubles'] })]),                    sections: () => sportsSections([fOpt('Play Category', 'radio', { options: ["Men's Singles", "Women's Singles", "Men's Doubles", "Women's Doubles", 'Mixed Doubles'] })]),                    defaultRules: [] },
  { id: 'sports_swim',     label: 'Swimming Registration',  description: 'Swimming event and relay form',              eventType: 'sports', subtypes: ['swimming'],                        fields: () => sportsFields([fOpt('Event Category', 'multiselect', { options: ['50m Freestyle', '100m Freestyle', '200m Freestyle', '100m Breaststroke', '100m Backstroke', '100m Butterfly', '200m IM', 'Open Water'] })]), sections: () => sportsSections([fOpt('Event Category', 'multiselect', { options: ['50m Freestyle', '100m Freestyle', '200m Freestyle', '100m Breaststroke', '100m Backstroke', '100m Butterfly', '200m IM', 'Open Water'] })]), defaultRules: [] },
  { id: 'sports_triathlon',label: 'Triathlon Registration', description: 'Triathlon and duathlon form',                eventType: 'sports', subtypes: ['triathlon'],                       fields: () => sportsFields([fOpt('Race Category', 'radio', { options: ['Super Sprint', 'Sprint', 'Olympic', 'Half Iron (70.3)', 'Full Iron (140.6)'] })]),                                sections: () => sportsSections([fOpt('Race Category', 'radio', { options: ['Super Sprint', 'Sprint', 'Olympic', 'Half Iron (70.3)', 'Full Iron (140.6)'] })]),                                defaultRules: [] },
  { id: 'sports_default',  label: 'Sports Registration',    description: 'General sports event registration form',     eventType: 'sports', subtypes: [],                                  fields: () => sportsFields(), sections: () => sportsSections(), defaultRules: [] },
  { id: 'sports_hockey',
    label: 'Hockey Registration', description: 'Team and player registration for hockey tournaments',
    eventType: 'sports', subtypes: ['hockey'],
    fields:   () => sportsFields([f('Team Name', 'text'), fOpt('Tournament Format', 'dropdown', { options: ['League', 'Knockout', 'Group Stage', 'Friendly', 'Custom'] }), fOpt('Player Position', 'dropdown', { options: ['Forward', 'Midfielder', 'Defender', 'Goalkeeper', 'Any / Open'] })]),
    sections: () => teamSportSections([f('Team Name', 'text'), fOpt('Tournament Format', 'dropdown', { options: ['League', 'Knockout', 'Group Stage', 'Friendly', 'Custom'] }), fOpt('Player Position', 'dropdown', { options: ['Forward', 'Midfielder', 'Defender', 'Goalkeeper', 'Any / Open'] })]),
    defaultRules: [], passGroups: SPORTS_TEAM_PASS_GROUPS },
  { id: 'sports_basketball',
    label: 'Basketball Registration', description: 'Team and player registration for basketball tournaments',
    eventType: 'sports', subtypes: ['basketball'],
    fields:   () => sportsFields([f('Team Name', 'text'), fOpt('Tournament Format', 'dropdown', { options: ['3×3 Basketball', '5v5 Basketball', 'Half Court', 'Full Court', 'Custom'] }), fOpt('Player Position', 'dropdown', { options: ['Point Guard', 'Shooting Guard', 'Small Forward', 'Power Forward', 'Center', 'Any'] })]),
    sections: () => teamSportSections([f('Team Name', 'text'), fOpt('Tournament Format', 'dropdown', { options: ['3×3 Basketball', '5v5 Basketball', 'Half Court', 'Full Court', 'Custom'] }), fOpt('Player Position', 'dropdown', { options: ['Point Guard', 'Shooting Guard', 'Small Forward', 'Power Forward', 'Center', 'Any'] })]),
    defaultRules: [], passGroups: SPORTS_TEAM_PASS_GROUPS },
  { id: 'sports_volleyball',
    label: 'Volleyball Registration', description: 'Team and player registration for volleyball tournaments',
    eventType: 'sports', subtypes: ['volleyball'],
    fields:   () => sportsFields([f('Team Name', 'text'), fOpt('Tournament Format', 'dropdown', { options: ['Indoor 6v6', 'Beach 2s (Pairs)', 'Mixed Indoor', 'Mixed Beach', 'Custom'] }), fOpt('Player Position', 'dropdown', { options: ['Setter', 'Outside Hitter', 'Middle Blocker', 'Opposite Hitter', 'Libero', 'Any'] })]),
    sections: () => teamSportSections([f('Team Name', 'text'), fOpt('Tournament Format', 'dropdown', { options: ['Indoor 6v6', 'Beach 2s (Pairs)', 'Mixed Indoor', 'Mixed Beach', 'Custom'] }), fOpt('Player Position', 'dropdown', { options: ['Setter', 'Outside Hitter', 'Middle Blocker', 'Opposite Hitter', 'Libero', 'Any'] })]),
    defaultRules: [], passGroups: SPORTS_TEAM_PASS_GROUPS },

  // ── Workshop & Training ───────────────────────────────────────────────────────
  { id: 'ws_workshop',     label: 'Workshop Registration',      description: 'Hands-on workshop form',               eventType: 'workshop', subtypes: ['workshop'],          fields: () => wsFields(), sections: () => wsSections(), defaultRules: [] },
  { id: 'ws_bootcamp',     label: 'Bootcamp Registration',      description: 'Intensive bootcamp registration',      eventType: 'workshop', subtypes: ['bootcamp'],          fields: () => wsFields([fOpt('Bootcamp Track', 'dropdown', { options: ['Web Dev', 'Mobile Dev', 'AI / ML', 'Cloud / DevOps', 'UI / UX', 'Data Science', 'Other'] })]), sections: () => wsSections([fOpt('Bootcamp Track', 'dropdown', { options: ['Web Dev', 'Mobile Dev', 'AI / ML', 'Cloud / DevOps', 'UI / UX', 'Data Science', 'Other'] })]), defaultRules: [] },
  { id: 'ws_cert',         label: 'Certification Course',       description: 'Certification programme form',         eventType: 'workshop', subtypes: ['certification'],    fields: () => wsFields([fOpt('Previous Certifications', 'text'), fOpt('Why are you attending?', 'textarea')]), sections: () => wsSections([fOpt('Previous Certifications', 'text'), fOpt('Why are you attending?', 'textarea')]), defaultRules: [] },
  { id: 'ws_masterclass',  label: 'Masterclass Registration',   description: 'Expert-led masterclass form',          eventType: 'workshop', subtypes: ['masterclass'],      fields: () => wsFields([fOpt('What do you hope to learn?', 'textarea')]), sections: () => wsSections([fOpt('What do you hope to learn?', 'textarea')]), defaultRules: [] },
  { id: 'ws_default',      label: 'Workshop / Training',        description: 'Standard workshop registration form',  eventType: 'workshop', subtypes: [],                   fields: () => wsFields(), sections: () => wsSections(), defaultRules: [] },

  // ── Business Meetup ───────────────────────────────────────────────────────────
  { id: 'meetup_networking',label: 'Networking Meetup',   description: 'Professional networking event form',        eventType: 'meetup', subtypes: ['networking'],          fields: () => meetupFields(), sections: () => meetupSections(), defaultRules: [] },
  { id: 'meetup_startup',   label: 'Startup Meetup',      description: 'Startup ecosystem meetup form',             eventType: 'meetup', subtypes: ['startup'],            fields: () => meetupFields([fOpt('Startup Stage', 'dropdown', { options: ['Idea Stage', 'MVP', 'Seed Funded', 'Growth Stage', 'Scale-up'] }), fOpt('Startup Name', 'text')]), sections: () => meetupSections([fOpt('Startup Stage', 'dropdown', { options: ['Idea Stage', 'MVP', 'Seed Funded', 'Growth Stage', 'Scale-up'] }), fOpt('Startup Name', 'text')]), defaultRules: [] },
  { id: 'meetup_investor',  label: 'Investor Meetup',     description: 'Investor and startup networking form',      eventType: 'meetup', subtypes: ['investor'],           fields: () => meetupFields([fOpt('Attending As', 'radio', { options: ['Investor', 'Startup Founder', 'Mentor', 'Ecosystem Partner'] })]), sections: () => meetupSections([fOpt('Attending As', 'radio', { options: ['Investor', 'Startup Founder', 'Mentor', 'Ecosystem Partner'] })]), defaultRules: [] },
  { id: 'meetup_default',   label: 'Business Meetup',     description: 'Standard business meetup form',             eventType: 'meetup', subtypes: [],                     fields: () => meetupFields(), sections: () => meetupSections(), defaultRules: [] },
  { id: 'meetup_founder',
    label: 'Founder Circle', description: 'Founder and startup circle meetup registration',
    eventType: 'meetup', subtypes: ['founder'],
    fields:   () => meetupFields([fOpt('Startup Stage', 'dropdown', { options: ['Idea Stage', 'Building MVP', 'Pre-Seed', 'Seed Funded', 'Growth Stage', 'Series A+'] }), fOpt('Industry / Domain', 'text')]),
    sections: () => [
      makeSection('Personal Information',   core(), 0),
      makeSection('Startup Information',    [...org(), fOpt('Startup Stage', 'dropdown', { options: ['Idea Stage', 'Building MVP', 'Pre-Seed', 'Seed Funded', 'Growth Stage', 'Series A+'] }), fOpt('Industry / Domain', 'text')], 1),
      makeSection('Networking Preferences', [fOpt('Areas of Interest', 'multiselect', { options: ['Fundraising', 'Co-founders', 'Mentorship', 'Partnerships', 'Customers', 'Hiring', 'Learning'] }), fOpt('LinkedIn Profile', 'url', { placeholder: 'https://linkedin.com/in/...' })], 2),
      makeSection('Terms & Consent', [], 3),
    ],
    defaultRules: [] },
  { id: 'meetup_corporate',
    label: 'Corporate Meetup', description: 'Corporate team and leadership meetup registration',
    eventType: 'meetup', subtypes: ['corporate'],
    fields:   () => meetupFields([fOpt('Department / Team', 'text'), fOpt('Seniority Level', 'dropdown', { options: ['Executive / C-Suite', 'Director', 'Senior Manager', 'Manager', 'Senior Professional', 'Professional'] })]),
    sections: () => meetupSections([fOpt('Department / Team', 'text'), fOpt('Seniority Level', 'dropdown', { options: ['Executive / C-Suite', 'Director', 'Senior Manager', 'Manager', 'Senior Professional', 'Professional'] })]),
    defaultRules: [] },
  { id: 'meetup_alumni',
    label: 'Alumni Meetup', description: 'Alumni reunion and networking event registration',
    eventType: 'meetup', subtypes: ['alumni'],
    fields:   () => meetupFields([fOpt('Batch / Graduation Year', 'text'), fOpt('Department / Course', 'text'), fOpt('Current City', 'city')]),
    sections: () => [
      makeSection('Personal Information',   [...core(), fOpt('Current City', 'city')], 0),
      makeSection('Alumni Information',     [fOpt('Batch / Graduation Year', 'text'), fOpt('Department / Course', 'text'), fOpt('Degree / Programme', 'text', { placeholder: 'e.g. B.Tech Computer Science' })], 1),
      makeSection('Networking Preferences', [...org(), fOpt('Areas of Interest', 'multiselect', { options: ['Reunions', 'Networking', 'Mentorship', 'Career Opportunities', 'Social Catch-up'] }), fOpt('LinkedIn Profile', 'url', { placeholder: 'https://linkedin.com/in/...' })], 2),
      makeSection('Terms & Consent', [], 3),
    ],
    defaultRules: [] },

  // ── Community & Awareness ─────────────────────────────────────────────────────
  { id: 'comm_awareness',  label: 'Awareness Program',    description: 'Community awareness registration',           eventType: 'community', subtypes: ['awareness'],       fields: () => commFields(), sections: () => commSections(), defaultRules: [] },
  { id: 'comm_volunteer',  label: 'Volunteer Program',    description: 'Volunteer registration form',                eventType: 'community', subtypes: ['volunteer'],       fields: () => commFields(), sections: () => commSections(), defaultRules: [] },
  { id: 'comm_ngo',        label: 'NGO Event',            description: 'NGO event and campaign registration form',   eventType: 'community', subtypes: ['ngo'],             fields: () => commFields([fOpt('Campaign / Cause Name', 'text')]), sections: () => commSections([fOpt('Campaign / Cause Name', 'text')]), defaultRules: [] },
  { id: 'comm_default',    label: 'Community Event',      description: 'Standard community event form',              eventType: 'community', subtypes: [],                  fields: () => commFields(), sections: () => commSections(), defaultRules: [] },

  // ── Cultural & Entertainment ──────────────────────────────────────────────────
  { id: 'cult_concert',    label: 'Concert Registration',     description: 'Concert and fan event form',             eventType: 'cultural', subtypes: ['concert'],                               fields: () => cultFields(), sections: () => cultSections(), defaultRules: [] },
  { id: 'cult_festival',   label: 'Festival Registration',    description: 'Cultural festival form',                 eventType: 'cultural', subtypes: ['festival'],                              fields: () => cultFields([fOpt('Category / Performance Type', 'multiselect', { options: ['Music', 'Dance', 'Drama', 'Art', 'Food', 'Craft'] })]), sections: () => cultSections([fOpt('Category / Performance Type', 'multiselect', { options: ['Music', 'Dance', 'Drama', 'Art', 'Food', 'Craft'] })]), defaultRules: [] },
  { id: 'cult_program',    label: 'Cultural Programme',       description: 'Cultural programme registration form',   eventType: 'cultural', subtypes: ['cultural', 'dance', 'drama', 'dj_night', 'talent'], fields: () => cultFields(), sections: () => cultSections(), defaultRules: [] },
  { id: 'cult_default',    label: 'Cultural Event',           description: 'Standard cultural event form',           eventType: 'cultural', subtypes: [],                                        fields: () => cultFields(), sections: () => cultSections(), defaultRules: [] },

  // ── Awards & Recognition ──────────────────────────────────────────────────────
  { id: 'award_night',     label: 'Awards Night',           description: 'Awards night guest registration',          eventType: 'awards', subtypes: ['awards_night'],                              fields: () => awardFields(), sections: () => awardSections(), defaultRules: [] },
  { id: 'award_ceremony',  label: 'Recognition Ceremony',   description: 'Ceremony guest registration form',         eventType: 'awards', subtypes: ['recognition', 'graduation', 'felicitation', 'excellence'], fields: () => awardFields([fOpt('Department / Division', 'text')]), sections: () => awardSections([fOpt('Department / Division', 'text')]), defaultRules: [] },
  { id: 'award_default',   label: 'Awards Registration',    description: 'Standard awards event form',               eventType: 'awards', subtypes: [],                                              fields: () => awardFields(), sections: () => awardSections(), defaultRules: [] },

  // ── Fundraising & Charity ─────────────────────────────────────────────────────
  { id: 'fund_charity',    label: 'Charity Event',     description: 'Charity event and donor registration form',    eventType: 'fundraising', subtypes: ['charity_run', 'donation_drive', 'benefit_dinner', 'gala', 'campaign'], fields: () => fundFields(), sections: () => fundSections(), defaultRules: [] },
  { id: 'fund_fundraiser', label: 'Fundraiser',        description: 'Fundraising campaign registration',            eventType: 'fundraising', subtypes: ['fundraiser'],                                                          fields: () => fundFields([fOpt('Campaign / Cause', 'text')]), sections: () => fundSections([fOpt('Campaign / Cause', 'text')]), defaultRules: [] },
  { id: 'fund_default',    label: 'Fundraising Event', description: 'Standard fundraising event form',              eventType: 'fundraising', subtypes: [],                                                                      fields: () => fundFields(), sections: () => fundSections(), defaultRules: [] },

  // ── Custom Event ──────────────────────────────────────────────────────────────
  { id: 'custom_blank',    label: 'Blank Form',         description: 'Start with just the core fields',             eventType: 'custom', subtypes: [], fields: () => [...core()], sections: () => [makeSection('Registration Details', [...core()], 0)], defaultRules: [] },
  { id: 'custom_basic',    label: 'Basic Registration', description: 'Name, email, mobile + notes field',           eventType: 'custom', subtypes: [], fields: () => [...core(), fOpt('Notes / Message', 'textarea')], sections: () => [makeSection('Registration Details', [...core(), fOpt('Notes / Message', 'textarea')], 0)], defaultRules: [] },
]

// ─── Public accessors ─────────────────────────────────────────────────────────

export function getFormTemplates(
  eventType?:    string | null,
  eventSubtype?: string | null,
): FormTemplateConfig[] {
  if (!eventType) return TEMPLATES.filter(t => t.eventType === 'custom')
  const byType = TEMPLATES.filter(t => t.eventType === eventType)
  if (byType.length === 0) return TEMPLATES.filter(t => t.eventType === 'custom')
  const generic = byType.filter(t => t.subtypes.length === 0)
  if (eventSubtype) {
    const subtypeMatch = byType.filter(t => t.subtypes.includes(eventSubtype))
    // If no exact subtype match, show only generic fallbacks (not every template
    // for the event type) so unrecognised subtypes like 'hockey' or 'founder'
    // get a clean single-option list rather than all sibling templates.
    return subtypeMatch.length > 0 ? [...subtypeMatch, ...generic] : generic
  }
  return byType
}

export function getDefaultFormTemplate(
  eventType?:    string | null,
  eventSubtype?: string | null,
): FormTemplateConfig | null {
  return getFormTemplates(eventType, eventSubtype)[0] ?? null
}

export function makeBlankField(): FormField {
  return {
    id: makeFieldId(), label: '', type: 'text', required: false,
    visible: true, placeholder: '', helperText: '', options: [],
    validation: {}, section: 'basic', conditionalLogic: null, passVisibility: 'all',
  }
}

export const BLANK_FORM_SETTINGS: FormSettings = {
  allowGuestRegistration:   false,
  requireApproval:          false,
  requireLogin:             false,
  allowFileUpload:          false,
  oneRegistrationPerEmail:  true,
  oneRegistrationPerMobile: false,
}

export const BLANK_TEAM_SETTINGS: TeamSettings = {
  minTeamSize:     null,
  maxTeamSize:     null,
  captainRequired: false,
  teamNameRequired:true,
}

export const BLANK_REGISTRATION_RULES: RegistrationRules = {
  registrationMode:          'individual',
  limitPerEmail:             true,
  limitPerMobile:            false,
  maxRegistrations:          null,
  duplicatePolicy:           'block',
  approvalMode:              'auto',
  approvalMessage:           '',
  pendingMessage:            '',
  waitlistEnabled:           false,
  waitlistMode:              'auto',
  waitlistCapacity:          null,
  requireLogin:              false,
  allowGuestRegistration:    false,
  requireEmailVerification:  false,
  requireMobileVerification: false,
  allowFileUpload:           false,
  teamSettings:              { ...BLANK_TEAM_SETTINGS },
  afterRegistration:         'success_page',
  redirectUrl:               '',
  successMessage:            '',
  confirmationMessage:       '',
}

export function makeBlankFormDraft(): RegistrationFormDraft {
  return {
    template:          '',
    sections:          [],
    fields:            [],
    settings:          { ...BLANK_FORM_SETTINGS },
    registrationRules: { ...BLANK_REGISTRATION_RULES, teamSettings: { ...BLANK_TEAM_SETTINGS } },
    conditionalRules:  [],
  }
}

/** Returns a flat field list derived from sections (authoritative source). */
export function deriveFields(sections: FormSection[]): FormField[] {
  return sections.flatMap(s => s.fields)
}

/** Wraps a legacy flat field list into a single default section. */
export function migrateFieldsToSections(fields: FormField[]): FormSection[] {
  if (fields.length === 0) return []
  return [{
    id:          makeSectionId(),
    title:       'Registration Details',
    description: '',
    order:       0,
    fields,
  }]
}

/**
 * After generating base sections from a template, appends pass-specific fields
 * produced by passGroups into the last non-consent section (or a new
 * "Additional Information" section if every section is consent-type).
 */
export function applyPassGroupsToSections(
  sections:   FormSection[],
  passGroups: PassFieldGroup[] | undefined,
  passes:     { id: string; name: string }[],
): FormSection[] {
  if (!passGroups || passGroups.length === 0 || passes.length === 0) return sections

  const passFields: FormField[] = []
  for (const group of passGroups) {
    const match = passes.find(p =>
      group.passNameHints.some(hint => p.name.toLowerCase().includes(hint))
    )
    if (match) {
      passFields.push(
        ...group.fields().map(field => ({ ...field, passVisibility: [match.id] as string[] })),
      )
    }
  }
  if (passFields.length === 0) return sections

  // Merge same-label pass-specific fields by combining their passVisibility arrays
  // so two groups emitting the same label (e.g. "Company Name" for Visitor and
  // Exhibitor passes) produce one field visible to both passes, not two duplicates.
  const passMap = new Map<string, FormField>()
  for (const field of passFields) {
    const key      = field.label.toLowerCase().trim()
    const existing = passMap.get(key)
    if (existing) {
      const ev = Array.isArray(existing.passVisibility) ? existing.passVisibility : []
      const nv = Array.isArray(field.passVisibility)   ? field.passVisibility   : []
      passMap.set(key, { ...existing, passVisibility: [...ev, ...nv] })
    } else {
      passMap.set(key, field)
    }
  }
  const mergedPassFields = Array.from(passMap.values())

  // Dedup: skip pass-specific fields whose label already exists in the base form
  // (passVisibility = 'all') to prevent duplicate fields when base template and
  // pass groups both generate the same field (e.g. blood group, t-shirt size).
  const baseLabels = new Set<string>()
  for (const s of sections) {
    for (const f of s.fields) {
      if (f.passVisibility === 'all') {
        baseLabels.add(f.label.toLowerCase().trim())
      }
    }
  }
  const deduped = mergedPassFields.filter(f => !baseLabels.has(f.label.toLowerCase().trim()))
  if (deduped.length === 0) return sections

  const consentKws = ['consent', 'terms', 'declaration', 'agreement']
  const isConsent  = (s: FormSection) =>
    consentKws.some(kw => s.title.toLowerCase().includes(kw))

  const lastNonConsentIdx = sections.reduce<number>((best, s, i) => (isConsent(s) ? best : i), -1)

  if (lastNonConsentIdx === -1) {
    return [...sections, {
      id: makeSectionId(), title: 'Additional Information',
      description: '', order: sections.length, fields: deduped,
    }]
  }
  return sections.map((s, i) =>
    i === lastNonConsentIdx ? { ...s, fields: [...s.fields, ...deduped] } : s
  )
}

/**
 * Given a base field list from a template, appends pass-specific fields that
 * matched against the provided passes by name (case-insensitive substring).
 * Fields added this way have passVisibility set to the matched pass's id.
 * Unmatched groups are silently skipped — the user can add fields manually.
 */
export function applyPassGroups(
  baseFields: FormField[],
  passGroups: PassFieldGroup[] | undefined,
  passes:     { id: string; name: string }[],
): FormField[] {
  if (!passGroups || passGroups.length === 0 || passes.length === 0) return baseFields
  const extra: FormField[] = []
  for (const group of passGroups) {
    const match = passes.find(p =>
      group.passNameHints.some(hint => p.name.toLowerCase().includes(hint))
    )
    if (match) {
      extra.push(
        ...group.fields().map(field => ({ ...field, passVisibility: [match.id] as string[] })),
      )
    }
  }
  // Merge same-label pass-specific fields by combining their passVisibility arrays.
  const extraMap = new Map<string, FormField>()
  for (const field of extra) {
    const key      = field.label.toLowerCase().trim()
    const existing = extraMap.get(key)
    if (existing) {
      const ev = Array.isArray(existing.passVisibility) ? existing.passVisibility : []
      const nv = Array.isArray(field.passVisibility)   ? field.passVisibility   : []
      extraMap.set(key, { ...existing, passVisibility: [...ev, ...nv] })
    } else {
      extraMap.set(key, field)
    }
  }
  // Dedup against base fields (aligns with applyPassGroupsToSections behaviour):
  // skip pass-specific fields whose label already exists in the base template as
  // an all-passes field so the base field covers all attendees without duplication.
  const baseLabels = new Set(
    baseFields
      .filter(f => f.passVisibility === 'all')
      .map(f => f.label.toLowerCase().trim()),
  )
  return [
    ...baseFields,
    ...Array.from(extraMap.values()).filter(f => !baseLabels.has(f.label.toLowerCase().trim())),
  ]
}
