const ROUTE_CACHE_TTL_MS = 60 * 1000;
const PLACE_CACHE_TTL_MS = 5 * 60 * 1000;

const routeCache = new Map();
const placeCache = new Map();

const OSRM_DIRECTIONS_URL = process.env.OSRM_DIRECTIONS_URL || 'https://router.project-osrm.org/route/v1/driving';
const NOMINATIM_REVERSE_URL = process.env.NOMINATIM_REVERSE_URL || 'https://nominatim.openstreetmap.org/reverse';

const toFixedCoord = (value) => Number.parseFloat(Number(value).toFixed(6));

const getCache = (store, key) => {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expireAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return hit.value;
};

const setCache = (store, key, value, ttlMs) => {
  store.set(key, { value, expireAt: Date.now() + ttlMs });
};

const fetchJson = async (url, options = {}, timeoutMs = 12_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${text.slice(0, 220)}`.trim());
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
};

const formatDuration = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h <= 0) return `${Math.max(1, m)} min`;
  if (m <= 0) return `${h} hr`;
  return `${h} hr ${m} min`;
};

const formatDistance = (meters) => {
  const m = Number(meters) || 0;
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
};

const normalizeRoute = (coordinates, distance, duration, provider) => ({
  provider,
  coordinates: (coordinates || []).map(([lng, lat]) => [toFixedCoord(lat), toFixedCoord(lng)]),
  distance_m: Math.round(Number(distance) || 0),
  duration_s: Math.round(Number(duration) || 0),
  distance_text: formatDistance(distance),
  duration_text: formatDuration(duration),
  eta_iso: new Date(Date.now() + (Math.max(0, Number(duration) || 0) * 1000)).toISOString(),
});

const getRouteFromOsrm = async (fromLat, fromLng, toLat, toLng) => {
  const coords = `${toFixedCoord(fromLng)},${toFixedCoord(fromLat)};${toFixedCoord(toLng)},${toFixedCoord(toLat)}`;
  const query = new URLSearchParams({
    alternatives: 'false',
    overview: 'full',
    geometries: 'geojson',
    steps: 'false',
  });

  const data = await fetchJson(`${OSRM_DIRECTIONS_URL}/${coords}?${query.toString()}`);
  const route = data?.routes?.[0];
  if (!route?.geometry?.coordinates?.length) {
    throw new Error('No road route found from provider');
  }

  return normalizeRoute(route.geometry.coordinates, route.distance, route.duration, 'osrm');
};

const getNominatimPlaceName = async (lat, lng) => {
  const query = new URLSearchParams({
    format: 'jsonv2',
    lat: String(toFixedCoord(lat)),
    lon: String(toFixedCoord(lng)),
    zoom: '12',
    addressdetails: '1',
  });

  const data = await fetchJson(`${NOMINATIM_REVERSE_URL}?${query.toString()}`, {
    headers: {
      'User-Agent': 'RiverGreen/1.0 (directions)',
    },
  });

  const address = data?.address || {};
  return (
    address.village
    || address.town
    || address.city
    || address.hamlet
    || address.suburb
    || address.county
    || data?.name
    || data?.display_name?.split(',')?.[0]
    || 'Unknown location'
  );
};

export const getPlaceName = async (lat, lng) => {
  const key = `${toFixedCoord(lat)},${toFixedCoord(lng)}`;
  const cached = getCache(placeCache, key);
  if (cached) return cached;

  const name = await getNominatimPlaceName(lat, lng);

  setCache(placeCache, key, name, PLACE_CACHE_TTL_MS);
  return name;
};

export const getRoadRoute = async (fromLat, fromLng, toLat, toLng) => {
  const key = `${toFixedCoord(fromLat)},${toFixedCoord(fromLng)}:${toFixedCoord(toLat)},${toFixedCoord(toLng)}`;
  const cached = getCache(routeCache, key);
  if (cached) return cached;

  const route = await getRouteFromOsrm(fromLat, fromLng, toLat, toLng);

  setCache(routeCache, key, route, ROUTE_CACHE_TTL_MS);
  return route;
};
