export type EventCategory =
  | "Conference"
  | "Workshop"
  | "Rotary"
  | "Marathon"
  | "Corporate";

export interface HeroSlide {
  /** Stable unique key */
  id: string;
  /** Category pill shown on the floating card */
  category: EventCategory;
  /** Event name (kept short — one line on desktop) */
  title: string;
  /** City, Country */
  location: string;
  /** Banner image URL (16:10-ish landscape works best) */
  image: string;
  /** Descriptive alt text for accessibility */
  alt: string;
  /** Short uppercase month, e.g. "JUN" */
  dateMonth: string;
  /** Day number, e.g. "21" */
  dateDay: string;
  /** Attendee summary, e.g. "+230 attending" */
  attending: string;
  /** Small avatar thumbnails for the attendee stack */
  avatars: string[];
  /** Optional link for the "View Details" action */
  href?: string;
}