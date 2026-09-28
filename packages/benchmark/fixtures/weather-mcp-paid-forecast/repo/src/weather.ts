/**
 * A bundled sample of National Weather Service alerts and forecasts, so the
 * server answers the same way offline, in tests and in demos.
 */

export interface Alert {
  readonly event: string;
  readonly area: string;
  readonly severity: "Minor" | "Moderate" | "Severe" | "Extreme";
  readonly headline: string;
  readonly instruction: string;
}

export interface ForecastPeriod {
  readonly name: string;
  readonly temperatureF: number;
  readonly wind: string;
  readonly summary: string;
}

export interface Station {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly periods: readonly ForecastPeriod[];
}

const ALERTS: Readonly<Record<string, readonly Alert[]>> = {
  CA: [
    {
      event: "Red Flag Warning",
      area: "Santa Clara Valley including San Jose",
      severity: "Severe",
      headline: "Red Flag Warning until Thursday 8 PM PDT",
      instruction: "Avoid outdoor burning and anything that could spark a fire.",
    },
    {
      event: "Beach Hazards Statement",
      area: "San Francisco Coast",
      severity: "Moderate",
      headline: "Sneaker waves and strong rip currents through Friday",
      instruction: "Stay off jetties and keep away from the water's edge.",
    },
  ],
  FL: [
    {
      event: "Coastal Flood Advisory",
      area: "Coastal Miami-Dade County",
      severity: "Minor",
      headline: "Minor saltwater flooding at high tide through Sunday",
      instruction: "Do not drive through flooded roadways.",
    },
  ],
  TX: [
    {
      event: "Heat Advisory",
      area: "Travis County including Austin",
      severity: "Moderate",
      headline: "Heat index values up to 110 expected",
      instruction: "Drink plenty of fluids and check on relatives and neighbors.",
    },
  ],
  WA: [],
};

const STATIONS: readonly Station[] = [
  {
    name: "Seattle, WA",
    latitude: 47.6062,
    longitude: -122.3321,
    periods: [
      { name: "Tonight", temperatureF: 52, wind: "S 5 mph", summary: "Mostly cloudy, with patchy drizzle after midnight." },
      { name: "Wednesday", temperatureF: 64, wind: "SW 5 to 10 mph", summary: "Cloudy in the morning, then partly sunny." },
      { name: "Wednesday Night", temperatureF: 51, wind: "S 5 mph", summary: "Chance of light rain." },
    ],
  },
  {
    name: "Austin, TX",
    latitude: 30.2672,
    longitude: -97.7431,
    periods: [
      { name: "Tonight", temperatureF: 78, wind: "SE 5 mph", summary: "Mostly clear and warm." },
      { name: "Wednesday", temperatureF: 101, wind: "S 10 mph", summary: "Sunny and hot, with a heat index near 108." },
      { name: "Wednesday Night", temperatureF: 79, wind: "S 5 to 10 mph", summary: "Mostly clear." },
    ],
  },
  {
    name: "Miami, FL",
    latitude: 25.7617,
    longitude: -80.1918,
    periods: [
      { name: "Tonight", temperatureF: 80, wind: "E 10 mph", summary: "Isolated showers before 2 AM." },
      { name: "Wednesday", temperatureF: 90, wind: "E 10 to 15 mph", summary: "Scattered afternoon thunderstorms." },
      { name: "Wednesday Night", temperatureF: 80, wind: "E 10 mph", summary: "Partly cloudy." },
    ],
  },
  {
    name: "Denver, CO",
    latitude: 39.7392,
    longitude: -104.9903,
    periods: [
      { name: "Tonight", temperatureF: 55, wind: "SW 5 mph", summary: "Clear." },
      { name: "Wednesday", temperatureF: 84, wind: "W 10 mph", summary: "Sunny, with isolated storms over the foothills after 2 PM." },
      { name: "Wednesday Night", temperatureF: 56, wind: "SW 5 mph", summary: "Mostly clear." },
    ],
  },
];

/** How far, in degrees of latitude and longitude, a request may be from a station and still use its forecast. */
export const STATION_RADIUS_DEGREES = 0.5;

/** The active alerts for a two-letter state code, or undefined when the sample does not cover that state. */
export function alertsFor(state: string): readonly Alert[] | undefined {
  return ALERTS[state.toUpperCase()];
}

/** The station whose forecast covers a location, or undefined outside every station's radius. */
export function stationNear(latitude: number, longitude: number): Station | undefined {
  return STATIONS.find((s) => Math.abs(s.latitude - latitude) <= STATION_RADIUS_DEGREES && Math.abs(s.longitude - longitude) <= STATION_RADIUS_DEGREES);
}

export function formatAlert(alert: Alert): string {
  return [`${alert.event} (${alert.severity})`, `Area: ${alert.area}`, alert.headline, `What to do: ${alert.instruction}`].join("\n");
}

export function formatForecast(station: Station): string {
  const periods = station.periods.map((p) => `${p.name}: ${p.temperatureF}°F, wind ${p.wind}. ${p.summary}`);
  return [`Forecast for ${station.name}`, ...periods].join("\n");
}
