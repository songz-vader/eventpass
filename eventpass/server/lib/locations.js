// Tanzania's 31 regions (mainland 26 + Zanzibar 5).
export const REGIONS = [
  'Arusha', 'Dar es Salaam', 'Dodoma', 'Geita', 'Iringa', 'Kagera', 'Katavi', 'Kigoma', 'Kilimanjaro', 'Lindi',
  'Manyara', 'Mara', 'Mbeya', 'Morogoro', 'Mtwara', 'Mwanza', 'Njombe', 'Pwani', 'Rukwa', 'Ruvuma',
  'Shinyanga', 'Simiyu', 'Singida', 'Songwe', 'Tabora', 'Tanga',
  'Kaskazini Unguja', 'Kusini Unguja', 'Mjini Magharibi', 'Kaskazini Pemba', 'Kusini Pemba',
];

export function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// Deep link that opens Google Maps (the map app most guests in Tanzania have) — no API key or geocoder needed.
export function mapLink({ lat, lng, venue, district, region } = {}) {
  const base = 'https://www.google.com/maps/search/?api=1&query=';
  if (lat != null && lng != null && validCoords(Number(lat), Number(lng))) return base + encodeURIComponent(`${lat},${lng}`);
  const text = [venue, district, region].filter(Boolean).join(', ');
  return text ? base + encodeURIComponent(text) : '';
}

export const locationText = (ev) => [ev?.venue, ev?.district, ev?.region].filter(Boolean).join(', ');
