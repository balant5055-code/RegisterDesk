// ─── India geography for /events discovery ───────────────────────────────────
//
// Static reference data — states/UTs grouped by region, and coordinates for the cities the
// "Near me" resolver can snap a browser geolocation onto. This is NOT event data: nothing
// here is ever displayed as a result. The city chips and state counts shown on the page are
// always derived from the events the API actually returned.
//
// The coordinate table exists so "Near me" can work with zero backend and zero third-party
// geocoding: the browser gives a lat/lng, we pick the nearest city in the table, and that
// city name is sent as the existing `?city=` filter. A user far from every listed city gets
// an honest "no nearby city" result instead of a wrong one.

export interface IndiaRegion {
  name:   string
  states: readonly string[]
}

/** State/UT names as they are stored on `eventDetails.venue.physical.state`. */
export const INDIA_REGIONS: readonly IndiaRegion[] = [
  { name: 'North',      states: ['Delhi', 'Haryana', 'Punjab', 'Uttar Pradesh', 'Uttarakhand', 'Himachal Pradesh', 'Jammu & Kashmir', 'Ladakh', 'Chandigarh'] },
  { name: 'South',      states: ['Karnataka', 'Tamil Nadu', 'Kerala', 'Telangana', 'Andhra Pradesh', 'Puducherry', 'Lakshadweep'] },
  { name: 'West',       states: ['Maharashtra', 'Gujarat', 'Rajasthan', 'Goa', 'Dadra & Nagar Haveli and Daman & Diu'] },
  { name: 'East',       states: ['West Bengal', 'Bihar', 'Odisha', 'Jharkhand', 'Andaman & Nicobar Islands'] },
  { name: 'Central',    states: ['Madhya Pradesh', 'Chhattisgarh'] },
  { name: 'North East', states: ['Assam', 'Meghalaya', 'Tripura', 'Manipur', 'Mizoram', 'Nagaland', 'Arunachal Pradesh', 'Sikkim'] },
] as const

/** Every state/UT, flat — used to validate a stored value before offering it as a filter. */
export const INDIA_STATES: readonly string[] =
  INDIA_REGIONS.flatMap(r => r.states).sort((a, b) => a.localeCompare(b))

const REGION_OF_STATE = new Map<string, string>(
  INDIA_REGIONS.flatMap(r => r.states.map(s => [s.toLowerCase(), r.name] as const)),
)

export function regionOfState(state: string | null | undefined): string | null {
  return REGION_OF_STATE.get((state ?? '').trim().toLowerCase()) ?? null
}

// ─── Near-me resolution ──────────────────────────────────────────────────────

interface CityPoint { city: string; state: string; lat: number; lng: number }

/** Major Indian cities, for snapping a geolocation fix onto a city name. */
const CITY_POINTS: readonly CityPoint[] = [
  { city: 'Mumbai',        state: 'Maharashtra',      lat: 19.076, lng: 72.877 },
  { city: 'Delhi',         state: 'Delhi',            lat: 28.614, lng: 77.209 },
  { city: 'Gurugram',      state: 'Haryana',          lat: 28.457, lng: 77.026 },
  { city: 'Noida',         state: 'Uttar Pradesh',    lat: 28.535, lng: 77.391 },
  { city: 'Bengaluru',     state: 'Karnataka',        lat: 12.972, lng: 77.594 },
  { city: 'Mysuru',        state: 'Karnataka',        lat: 12.295, lng: 76.639 },
  { city: 'Hyderabad',     state: 'Telangana',        lat: 17.385, lng: 78.487 },
  { city: 'Chennai',       state: 'Tamil Nadu',       lat: 13.083, lng: 80.270 },
  { city: 'Coimbatore',    state: 'Tamil Nadu',       lat: 11.017, lng: 76.956 },
  { city: 'Tiruppur',      state: 'Tamil Nadu',       lat: 11.108, lng: 77.341 },
  { city: 'Madurai',       state: 'Tamil Nadu',       lat:  9.925, lng: 78.120 },
  { city: 'Salem',         state: 'Tamil Nadu',       lat: 11.664, lng: 78.146 },
  { city: 'Tiruchirappalli', state: 'Tamil Nadu',     lat: 10.790, lng: 78.704 },
  { city: 'Erode',         state: 'Tamil Nadu',       lat: 11.341, lng: 77.717 },
  { city: 'Kolkata',       state: 'West Bengal',      lat: 22.573, lng: 88.364 },
  { city: 'Pune',          state: 'Maharashtra',      lat: 18.520, lng: 73.857 },
  { city: 'Nagpur',        state: 'Maharashtra',      lat: 21.146, lng: 79.088 },
  { city: 'Nashik',        state: 'Maharashtra',      lat: 19.997, lng: 73.790 },
  { city: 'Ahmedabad',     state: 'Gujarat',          lat: 23.023, lng: 72.572 },
  { city: 'Surat',         state: 'Gujarat',          lat: 21.170, lng: 72.831 },
  { city: 'Vadodara',      state: 'Gujarat',          lat: 22.307, lng: 73.181 },
  { city: 'Rajkot',        state: 'Gujarat',          lat: 22.303, lng: 70.802 },
  { city: 'Jaipur',        state: 'Rajasthan',        lat: 26.912, lng: 75.787 },
  { city: 'Jodhpur',       state: 'Rajasthan',        lat: 26.238, lng: 73.024 },
  { city: 'Udaipur',       state: 'Rajasthan',        lat: 24.586, lng: 73.713 },
  { city: 'Lucknow',       state: 'Uttar Pradesh',    lat: 26.847, lng: 80.947 },
  { city: 'Kanpur',        state: 'Uttar Pradesh',    lat: 26.450, lng: 80.332 },
  { city: 'Varanasi',      state: 'Uttar Pradesh',    lat: 25.318, lng: 82.973 },
  { city: 'Agra',          state: 'Uttar Pradesh',    lat: 27.177, lng: 78.008 },
  { city: 'Chandigarh',    state: 'Chandigarh',       lat: 30.734, lng: 76.779 },
  { city: 'Ludhiana',      state: 'Punjab',           lat: 30.901, lng: 75.857 },
  { city: 'Amritsar',      state: 'Punjab',           lat: 31.634, lng: 74.872 },
  { city: 'Dehradun',      state: 'Uttarakhand',      lat: 30.317, lng: 78.032 },
  { city: 'Shimla',        state: 'Himachal Pradesh', lat: 31.105, lng: 77.173 },
  { city: 'Srinagar',      state: 'Jammu & Kashmir',  lat: 34.084, lng: 74.797 },
  { city: 'Kochi',         state: 'Kerala',           lat:  9.932, lng: 76.267 },
  { city: 'Thiruvananthapuram', state: 'Kerala',      lat:  8.524, lng: 76.937 },
  { city: 'Kozhikode',     state: 'Kerala',           lat: 11.259, lng: 75.780 },
  { city: 'Visakhapatnam', state: 'Andhra Pradesh',   lat: 17.687, lng: 83.219 },
  { city: 'Vijayawada',    state: 'Andhra Pradesh',   lat: 16.507, lng: 80.648 },
  { city: 'Bhubaneswar',   state: 'Odisha',           lat: 20.296, lng: 85.825 },
  { city: 'Patna',         state: 'Bihar',            lat: 25.594, lng: 85.138 },
  { city: 'Ranchi',        state: 'Jharkhand',        lat: 23.344, lng: 85.310 },
  { city: 'Raipur',        state: 'Chhattisgarh',     lat: 21.251, lng: 81.630 },
  { city: 'Bhopal',        state: 'Madhya Pradesh',   lat: 23.260, lng: 77.413 },
  { city: 'Indore',        state: 'Madhya Pradesh',   lat: 22.719, lng: 75.857 },
  { city: 'Guwahati',      state: 'Assam',            lat: 26.144, lng: 91.736 },
  { city: 'Shillong',      state: 'Meghalaya',        lat: 25.578, lng: 91.893 },
  { city: 'Panaji',        state: 'Goa',              lat: 15.499, lng: 73.828 },
] as const

/** Great-circle distance in km. */
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat  = toRad(bLat - aLat)
  const dLng  = toRad(bLng - aLng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(s))
}

/**
 * The city nearest to a geolocation fix, or null when nothing is within `maxKm`.
 *
 * Returning null rather than "the least-far city in India" is deliberate: snapping someone
 * outside the country onto a border city would silently apply a filter they never asked for.
 */
export function nearestCity(
  lat: number,
  lng: number,
  maxKm = 220,
): { city: string; state: string; km: number } | null {
  let best: { city: string; state: string; km: number } | null = null
  for (const p of CITY_POINTS) {
    const km = haversineKm(lat, lng, p.lat, p.lng)
    if (!best || km < best.km) best = { city: p.city, state: p.state, km }
  }
  return best && best.km <= maxKm ? best : null
}

// ─── Map projection + dot matrix ─────────────────────────────────────────────
//
// Powers the "across India" section's visual. It is generated geometry, NOT an image: a coarse
// national outline, an equirectangular projection into a fixed SVG viewBox, and a
// point-in-polygon sweep that turns the outline into a dot matrix.
//
// The outline is deliberately low-resolution — at this dot spacing one dot covers roughly
// 60km, so the silhouette reads as a stylised national shape rather than a cartographic
// boundary, which is the right level of detail for a decorative discovery visual.

/** SVG user-space size the projection targets. */
export const MAP_VIEWBOX = { width: 310, height: 330 } as const

const LON_MIN = 67.5
const LAT_MAX = 38.5
const SCALE   = 10

/** Longitude/latitude → SVG user space inside MAP_VIEWBOX. */
export function projectIndia(lng: number, lat: number): { x: number; y: number } {
  return { x: (lng - LON_MIN) * SCALE, y: (LAT_MAX - lat) * SCALE }
}

/** Coarse national outline, [lng, lat], clockwise from the north-west. */
const INDIA_OUTLINE: readonly (readonly [number, number])[] = [
  [74.0, 34.5], [75.0, 35.4], [77.0, 35.5], [78.6, 34.6], [79.5, 33.0], [79.0, 31.5],
  [81.0, 30.3], [83.0, 29.2], [85.0, 28.2], [88.0, 27.9], [88.8, 27.2], [89.6, 28.0],
  [92.0, 27.5], [94.5, 28.8], [96.5, 28.5], [97.4, 28.2], [97.0, 27.0], [96.4, 25.4],
  [95.2, 24.0], [93.4, 23.0], [92.6, 22.0], [91.5, 22.9], [89.9, 22.0], [88.2, 21.6],
  [87.0, 21.5], [85.0, 19.5], [82.5, 17.0], [80.3, 15.9], [80.2, 13.5], [79.8, 11.5],
  [79.3, 10.3], [78.2,  8.9], [77.5,  8.1], [76.6,  9.0], [75.8, 11.3], [74.9, 12.9],
  [73.8, 15.4], [72.9, 18.9], [72.6, 21.0], [72.9, 21.6], [72.0, 21.7], [69.0, 22.3],
  [68.2, 23.7], [68.7, 24.3], [70.5, 24.0], [71.0, 24.7], [70.6, 25.7], [69.6, 26.7],
  [70.1, 27.9], [71.9, 27.9], [72.9, 29.0], [74.5, 29.9], [74.6, 31.1], [75.4, 32.3],
  [74.3, 32.8],
] as const

/** Ray-casting point-in-polygon. */
function inside(lng: number, lat: number): boolean {
  let hit = false
  for (let i = 0, j = INDIA_OUTLINE.length - 1; i < INDIA_OUTLINE.length; j = i++) {
    const [xi, yi] = INDIA_OUTLINE[i]
    const [xj, yj] = INDIA_OUTLINE[j]
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/**
 * The dot matrix, computed ONCE at module load rather than per render.
 *
 * ~900 points at 0.62° spacing. Building this inside the component would re-run a
 * 2,500-iteration point-in-polygon sweep on every render of the section.
 */
export const INDIA_DOTS: readonly { x: number; y: number }[] = (() => {
  const step = 0.62
  const out: { x: number; y: number }[] = []
  for (let lat = 7; lat <= 37.4; lat += step) {
    for (let lng = 68; lng <= 97.6; lng += step) {
      if (inside(lng, lat)) out.push(projectIndia(lng, lat))
    }
  }
  return out
})()

const CITY_BY_NAME = new Map(CITY_POINTS.map(p => [p.city.toLowerCase(), p]))

/** Coordinates for a city name, or null when it is not in the reference table. */
export function cityCoords(name: string): { lat: number; lng: number } | null {
  const hit = CITY_BY_NAME.get(name.trim().toLowerCase())
  return hit ? { lat: hit.lat, lng: hit.lng } : null
}
