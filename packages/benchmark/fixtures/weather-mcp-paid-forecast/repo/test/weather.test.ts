import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { alertsFor, formatAlert, formatForecast, stationNear } from "../src/weather.js";

describe("alerts", () => {
  test("are found by state code in any case", () => {
    assert.equal(alertsFor("ca")?.length, 2);
    assert.equal(alertsFor("TX")?.[0]?.event, "Heat Advisory");
  });

  test("distinguish a covered state without alerts from one the sample does not cover", () => {
    assert.deepEqual(alertsFor("WA"), []);
    assert.equal(alertsFor("ZZ"), undefined);
  });

  test("read as event, area, headline and instruction", () => {
    const alert = alertsFor("FL")?.[0];
    assert.ok(alert);
    assert.equal(
      formatAlert(alert),
      "Coastal Flood Advisory (Minor)\nArea: Coastal Miami-Dade County\nMinor saltwater flooding at high tide through Sunday\nWhat to do: Do not drive through flooded roadways.",
    );
  });
});

describe("forecasts", () => {
  test("come from the station within half a degree", () => {
    assert.equal(stationNear(47.61, -122.33)?.name, "Seattle, WA");
    assert.equal(stationNear(30.5, -97.5)?.name, "Austin, TX");
  });

  test("are missing outside every station's radius", () => {
    assert.equal(stationNear(0, 0), undefined);
    assert.equal(stationNear(47.6062, -121.5), undefined);
  });

  test("list the next three periods", () => {
    const station = stationNear(25.76, -80.19);
    assert.ok(station);
    const lines = formatForecast(station).split("\n");
    assert.equal(lines[0], "Forecast for Miami, FL");
    assert.equal(lines.length, 4);
    assert.equal(lines[1], "Tonight: 80°F, wind E 10 mph. Isolated showers before 2 AM.");
  });
});
