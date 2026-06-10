import type { HeroSlide } from "./heroTypes";

const avatar = (seed: string) =>
  `https://i.pravatar.cc/80?img=${seed}`;

/**
 * Default slides for the RegisterDesk hero.
 * Swap the `image` URLs for your own CDN assets in production.
 */
export const heroSlides: HeroSlide[] = [
  {
    id: "tech-conference",
    category: "Conference",
    title: "Global Tech Summit 2024",
    location: "Bangalore, India",
    image:
      "https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1400&q=80",
    alt: "Speaker on stage addressing a large technology conference audience",
    dateMonth: "JUN",
    dateDay: "21",
    attending: "+230 attending",
    avatars: [avatar("11"), avatar("12"), avatar("13"), avatar("14")],
    href: "#",
  },
  {
    id: "design-workshop",
    category: "Workshop",
    title: "Design Systems Workshop",
    location: "Mumbai, India",
    image:
      "https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=1400&q=80",
    alt: "Small group collaborating around a table during a hands-on workshop",
    dateMonth: "JUL",
    dateDay: "08",
    attending: "+85 attending",
    avatars: [avatar("21"), avatar("22"), avatar("23"), avatar("24")],
    href: "#",
  },
  {
    id: "rotary-conference",
    category: "Rotary",
    title: "Rotary District Conference",
    location: "Chennai, India",
    image:
      "https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&w=1400&q=80",
    alt: "Formal conference hall filled with seated attendees",
    dateMonth: "AUG",
    dateDay: "15",
    attending: "+540 attending",
    avatars: [avatar("31"), avatar("32"), avatar("33"), avatar("34")],
    href: "#",
  },
  {
    id: "city-marathon",
    category: "Marathon",
    title: "City Heritage Marathon",
    location: "Coimbatore, India",
    image:
      "https://images.unsplash.com/photo-1452626038306-9aae5e071dd3?auto=format&fit=crop&w=1400&q=80",
    alt: "Crowd of runners taking part in an outdoor city marathon",
    dateMonth: "SEP",
    dateDay: "22",
    attending: "+1.2k attending",
    avatars: [avatar("41"), avatar("42"), avatar("43"), avatar("44")],
    href: "#",
  },
  {
    id: "corporate-meet",
    category: "Corporate",
    title: "Annual Leadership Meet",
    location: "Hyderabad, India",
    image:
      "https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=1400&q=80",
    alt: "Professionals networking at a corporate evening event",
    dateMonth: "OCT",
    dateDay: "05",
    attending: "+310 attending",
    avatars: [avatar("51"), avatar("52"), avatar("53"), avatar("54")],
    href: "#",
  },
];