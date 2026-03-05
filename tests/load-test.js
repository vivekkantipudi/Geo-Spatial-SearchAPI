/**
 * tests/load-test.js
 *
 * k6 Load Testing Script for the Geo-Spatial Search API
 *
 * Usage (cache enabled, default):
 *   k6 run tests/load-test.js
 *
 * Usage (against local Docker NGINX):
 *   k6 run -e BASE_URL=http://localhost tests/load-test.js
 *
 * Usage (skip cache run — comment out proxy_cache in nginx.conf first):
 *   k6 run -e TAG=no-cache tests/load-test.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// ──────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://localhost";
const TEST_TAG = __ENV.TAG || "cache-enabled";

// UK bounding box for random coordinate generation
const GEO_BOUNDS = {
    latMin: 50.5, latMax: 53.8,
    lonMin: -3.5, lonMax: 0.3,
};

// Pre-generated list of common search centres (to improve cache hit rate)
const SEARCH_CENTRES = [
    { lat: 51.5074, lon: -0.1278, label: "London", radius: 10 },
    { lat: 51.5074, lon: -0.1278, label: "London", radius: 5 },
    { lat: 53.4808, lon: -2.2426, label: "Manchester", radius: 8 },
    { lat: 52.4862, lon: -1.8904, label: "Birmingham", radius: 10 },
    { lat: 53.8008, lon: -1.5491, label: "Leeds", radius: 6 },
    { lat: 52.9548, lon: -1.1581, label: "Nottingham", radius: 7 },
    { lat: 51.4545, lon: -2.5879, label: "Bristol", radius: 8 },
    { lat: 53.4084, lon: -2.9916, label: "Liverpool", radius: 5 },
    { lat: 55.9533, lon: -3.1883, label: "Edinburgh", radius: 10 },
    { lat: 51.4816, lon: -3.1791, label: "Cardiff", radius: 6 },
];

// Pre-defined bounding boxes (to allow cache hits on repeated calls)
const BBOX_SEARCHES = [
    { tlLat: 51.7, tlLon: -0.5, brLat: 51.3, brLon: 0.2 },  // Greater London
    { tlLat: 53.6, tlLon: -2.5, brLat: 53.3, brLon: -2.0 },  // Greater Manchester
    { tlLat: 52.7, tlLon: -2.1, brLat: 52.3, brLon: -1.6 },  // West Midlands
    { tlLat: 53.9, tlLon: -1.7, brLat: 53.7, brLon: -1.3 },  // Leeds area
];

// ──────────────────────────────────────────────────────────────────────
// k6 Options
// ──────────────────────────────────────────────────────────────────────
export const options = {
    scenarios: {
        radius_search: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
                { duration: "15s", target: 10 },  // ramp up
                {
                    duration: "40s", target: 15
                },  // steady
                { duration: "5s", target: 0 },  // ramp down
            ],
            exec: "radiusScenario",
        },
        bbox_search: {
            executor: "constant-vus",
            vus: 5,
            duration: "60s",
            exec: "bboxScenario",
            startTime: "0s",
        },
    },

    thresholds: {
        // p95 response time must be under 500ms
        http_req_duration: ["p(95)<500"],
        // All requests must be successful (2xx or 429)
        "http_req_failed": ["rate<0.05"],
        // Cache hit rate metric
        "cache_hits": ["rate>0"],
    },

    tags: { test: TEST_TAG },
};

// ──────────────────────────────────────────────────────────────────────
// Custom Metrics
// ──────────────────────────────────────────────────────────────────────
const cacheHits = new Rate("cache_hits");
const searchDuration = new Trend("search_duration_ms");

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────
function randomPick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomRadius() {
    return [5, 8, 10, 15][Math.floor(Math.random() * 4)];
}

// ──────────────────────────────────────────────────────────────────────
// Scenario: Radius Search
// Mix of (70%) repeated common centres (for cache warmth) and
// (30%) random coordinates (to simulate unique queries)
// ──────────────────────────────────────────────────────────────────────
export function radiusScenario() {
    let url;

    if (Math.random() < 0.70) {
        // Repeated, cacheable query
        const centre = randomPick(SEARCH_CENTRES);
        url = `${BASE_URL}/api/properties/search/radius?lat=${centre.lat}&lon=${centre.lon}&radius_km=${centre.radius}`;
    } else {
        // Unique random query (cache MISS)
        const lat = (GEO_BOUNDS.latMin + Math.random() * (GEO_BOUNDS.latMax - GEO_BOUNDS.latMin)).toFixed(4);
        const lon = (GEO_BOUNDS.lonMin + Math.random() * (GEO_BOUNDS.lonMax - GEO_BOUNDS.lonMin)).toFixed(4);
        url = `${BASE_URL}/api/properties/search/radius?lat=${lat}&lon=${lon}&radius_km=${randomRadius()}`;
    }

    const res = http.get(url, {
        tags: { endpoint: "radius", test: TEST_TAG },
        timeout: "10s",
    });

    // Track cache status
    const cacheStatus = res.headers["X-Cache-Status"] || "";
    cacheHits.add(cacheStatus === "HIT");
    searchDuration.add(res.timings.duration, { endpoint: "radius" });

    check(res, {
        "radius search: status 2xx or 429": (r) => r.status === 200 || r.status === 429,
        "radius search: has hits array": (r) => {
            if (r.status !== 200) return true;
            try { return Array.isArray(JSON.parse(r.body).hits); } catch { return false; }
        },
        "radius search: has X-Cache-Status": (r) => !!r.headers["X-Cache-Status"],
    });

    sleep(Math.random() * 1 + 0.5);  // 0.5–1.5s think time
}

// ──────────────────────────────────────────────────────────────────────
// Scenario: Bounding Box Search
// ──────────────────────────────────────────────────────────────────────
export function bboxScenario() {
    const bbox = randomPick(BBOX_SEARCHES);
    const url = `${BASE_URL}/api/properties/search/bbox`
        + `?top_left_lat=${bbox.tlLat}&top_left_lon=${bbox.tlLon}`
        + `&bottom_right_lat=${bbox.brLat}&bottom_right_lon=${bbox.brLon}`;

    const res = http.get(url, {
        tags: { endpoint: "bbox", test: TEST_TAG },
        timeout: "10s",
    });

    const cacheStatus = res.headers["X-Cache-Status"] || "";
    cacheHits.add(cacheStatus === "HIT");
    searchDuration.add(res.timings.duration, { endpoint: "bbox" });

    check(res, {
        "bbox search: status 2xx or 429": (r) => r.status === 200 || r.status === 429,
        "bbox search: has hits array": (r) => {
            if (r.status !== 200) return true;
            try { return Array.isArray(JSON.parse(r.body).hits); } catch { return false; }
        },
        "bbox search: has X-Cache-Status": (r) => !!r.headers["X-Cache-Status"],
    });

    sleep(Math.random() * 1 + 0.5);
}

// ──────────────────────────────────────────────────────────────────────
// Default scenario (simple mode, single function for k6 run)
// ──────────────────────────────────────────────────────────────────────
export default function () {
    radiusScenario();
}
