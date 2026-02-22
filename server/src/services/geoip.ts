import geoip from "geoip-lite";

export interface GeoDetails {
  geo_country: string | null;
  geo_region: string | null;
  geo_city: string | null;
  latitude: number | null;
  longitude: number | null;
}

export function resolveGeoFromIp(ipAddress: string | null): GeoDetails {
  if (!ipAddress) {
    return emptyGeo();
  }

  const normalized = normalizeIp(ipAddress);
  const match = geoip.lookup(normalized);

  if (!match) {
    return emptyGeo();
  }

  return {
    geo_country: match.country ?? null,
    geo_region: match.region ?? null,
    geo_city: match.city ?? null,
    latitude: Array.isArray(match.ll) ? (match.ll[0] ?? null) : null,
    longitude: Array.isArray(match.ll) ? (match.ll[1] ?? null) : null
  };
}

function normalizeIp(value: string): string {
  const ip = value.trim();

  if (ip.startsWith("::ffff:")) {
    return ip.slice(7);
  }

  return ip;
}

function emptyGeo(): GeoDetails {
  return {
    geo_country: null,
    geo_region: null,
    geo_city: null,
    latitude: null,
    longitude: null
  };
}
