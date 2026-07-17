import { Users, Trophy, GraduationCap, Store, Heart, Music, Award } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TemplateDefinition {
  id:           string
  name:         string
  icon:         LucideIcon
  description:  string
  bestFor:      string[]
  keyFeatures:  string[]
  previewImage: string       // empty until real screenshots are added
  accentColor:  string       // CSS hex color
  badgeColor:   string       // Tailwind class pair for icon/accent backgrounds
  recommended?: boolean      // shows "Recommended" badge on the event-type card
}

// ─── Registry ──────────────────────────────────────────────────────────────────

export const TEMPLATE_REGISTRY: TemplateDefinition[] = [
  {
    id:          'community',
    name:        'Community & Awareness',
    icon:        Heart,
    description: 'Community programs, NGO activities and awareness campaigns with rich organizer and cause detail.',
    bestFor:     ['Awareness Drives', 'NGO Events', 'Volunteer Programs', 'Social Impact Campaigns'],
    keyFeatures: ['Organizer Profile', 'Speakers / Guests', 'Sponsors', 'Photo Gallery', 'Event FAQ'],
    previewImage: '',
    accentColor:  '#10b981',
    badgeColor:   'bg-emerald-50 text-emerald-700',
  },
  {
    id:          'conference',
    name:        'Conference',
    icon:        Users,
    description: 'Large-scale events with speaker lineups, multi-track sessions, networking and sponsorship.',
    bestFor:     ['Business Summits', 'Corporate Events', 'Tech Conferences', 'Academic Meets'],
    keyFeatures: ['Speakers & Agenda', 'Track Sessions', 'Networking Section', 'Sponsor Showcase', 'Ticket Tiers'],
    previewImage: '',
    accentColor:  '#7c3aed',
    badgeColor:   'bg-violet-50 text-violet-700',
    recommended:  true,
  },
  {
    id:          'sports',
    name:        'Sports & Fitness',
    icon:        Trophy,
    description: 'Race events, tournaments and fitness challenges with route maps, race kits and cut-off times.',
    bestFor:     ['Marathons & Runs', 'Cycling Events', 'Tournaments', 'Triathlons'],
    keyFeatures: ['Race Categories', 'Route Map', 'Race Kit Info', 'Cut-off Times', 'Pacer Profiles'],
    previewImage: '',
    accentColor:  '#f97316',
    badgeColor:   'bg-orange-50 text-orange-700',
    recommended:  true,
  },
  {
    id:          'workshop',
    name:        'Workshop & Training',
    icon:        GraduationCap,
    description: 'Skill-building sessions with instructor profiles, curriculum, learning outcomes and certification.',
    bestFor:     ['Bootcamps', 'Masterclasses', 'Certification Courses', 'Live Training Sessions'],
    keyFeatures: ['Instructor Profile', 'Curriculum / Agenda', 'Learning Outcomes', 'Certificate Section', 'Batch Enrollment'],
    previewImage: '',
    accentColor:  '#2563eb',
    badgeColor:   'bg-blue-50 text-blue-700',
  },
  {
    id:          'exhibition',
    name:        'Exhibition & Expo',
    icon:        Store,
    description: 'Trade shows, product expos and showcase events with exhibitor listings and floor plan support.',
    bestFor:     ['Trade Shows', 'Product Expos', 'Auto Fairs', 'Education Expos'],
    keyFeatures: ['Exhibitor Profiles', 'Category Listings', 'Sponsor Grid', 'Photo Gallery', 'Venue Map'],
    previewImage: '',
    accentColor:  '#f59e0b',
    badgeColor:   'bg-amber-50 text-amber-700',
  },
  {
    id:          'cultural',
    name:        'Cultural & Entertainment',
    icon:        Music,
    description: 'Concerts, festivals and cultural programs with performer lineups, schedule and a full gallery.',
    bestFor:     ['Concerts', 'Festivals', 'DJ Nights', 'Cultural & Dance Shows'],
    keyFeatures: ['Performer Profiles', 'Programme Schedule', 'Sponsors', 'Dark-theme Gallery', 'Venue Map'],
    previewImage: '',
    accentColor:  '#a855f7',
    badgeColor:   'bg-purple-50 text-purple-700',
  },
  {
    id:          'awards',
    name:        'Awards & Recognition',
    icon:        Award,
    description: 'Award ceremonies and gala nights with category listings, judges panel and nomination process.',
    bestFor:     ['Awards Nights', 'Recognition Ceremonies', 'Graduation Events', 'Excellence Awards'],
    keyFeatures: ['Award Categories', 'Judges Panel', 'Nomination Process', 'Hall of Fame', 'Ceremony Schedule'],
    previewImage: '',
    accentColor:  '#d97706',
    badgeColor:   'bg-yellow-50 text-yellow-700',
  },
]

// ─── Helpers ───────────────────────────────────────────────────────────────────

export function getTemplate(id: string): TemplateDefinition | undefined {
  return TEMPLATE_REGISTRY.find(t => t.id === id)
}
