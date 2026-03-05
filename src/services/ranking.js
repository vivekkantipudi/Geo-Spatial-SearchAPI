/**
 * src/services/ranking.js
 *
 * Builds an OpenSearch function_score query that implements custom ranking:
 *
 *  final_score = (price_score * 0.25)
 *              + (recency_score * 0.25)
 *              + (geo_score * 0.35)
 *              + (engagement_score * 0.15)
 *
 * OpenSearch function_score functions are multiplied together by default;
 * we change score_mode to "sum" and boost_mode to "replace" so we control
 * the final score entirely through our functions.
 *
 * Each function contributes a 0–1 normalised value:
 *  - Geo distance  : gauss decay, scale = radius/3, offset = 0
 *  - Recency       : gauss decay, scale = 365d,     origin = now
 *  - Price         : exp decay from a target price (or median if none)
 *  - Engagement    : field_value_factor on views_count, capped via log1p
 */

const MEDIAN_PRICE = 280_000; // approximate dataset median

/**
 * buildRankingQuery
 * @param {object} geoFilter  – a geo_distance or geo_bounding_box filter clause
 * @param {number} lat        – search centre latitude
 * @param {number} lon        – search centre longitude
 * @param {number} radiusKm   – search radius in km (used for decay scale)
 * @param {number|null} targetPrice – buyer's preferred price (optional)
 * @param {number} size       – max hits to return
 */
function buildRankingQuery({ geoFilter, lat, lon, radiusKm = 10, targetPrice = null, size = 50 }) {
    const priceOrigin = targetPrice || MEDIAN_PRICE;

    // Scale for geo decay: half the radius is a "good" distance
    const geoScale = Math.max(1, Math.round(radiusKm / 2)) + "km";
    const geoOffset = Math.max(0, Math.round(radiusKm * 0.1)) + "km";

    return {
        size,
        query: {
            function_score: {
                query: {
                    bool: {
                        filter: [geoFilter],
                    },
                },

                // score_mode: sum  → add all function scores
                // boost_mode: replace → use function sum as final score
                score_mode: "sum",
                boost_mode: "replace",

                functions: [
                    // ── 1. Geo-distance score (weight 0.35) ────────────────────
                    {
                        weight: 0.35,
                        gauss: {
                            location: {
                                origin: { lat, lon },
                                scale: geoScale,
                                offset: geoOffset,
                                decay: 0.5,
                            },
                        },
                    },

                    // ── 2. Recency score (weight 0.25) ─────────────────────────
                    {
                        weight: 0.25,
                        gauss: {
                            date_of_transfer: {
                                origin: "now",
                                scale: "365d",
                                offset: "30d",
                                decay: 0.5,
                            },
                        },
                    },

                    // ── 3. Price score (weight 0.25) ────────────────────────────
                    // exp decay: score drops as price deviates from target
                    {
                        weight: 0.25,
                        exp: {
                            price: {
                                origin: priceOrigin,
                                scale: priceOrigin * 0.5,
                                decay: 0.5,
                            },
                        },
                    },

                    // ── 4. Engagement score (weight 0.15) ─────────────────────
                    // log1p(views) normalised; factor brings it to ~0–1 range
                    {
                        weight: 0.15,
                        field_value_factor: {
                            field: "views_count",
                            modifier: "log1p",
                            factor: 0.15,
                            missing: 0,
                        },
                    },
                ],
            },
        },

        // Return source fields we care about
        _source: [
            "id", "price", "date_of_transfer", "property_type",
            "location", "city", "postcode", "views_count", "bedrooms", "bathrooms",
        ],
    };
}

/**
 * extractRankingExplanation
 * Given an OpenSearch hit, compute a breakdown of score components
 * using the function_score weights defined above.
 *
 * Because we don't enable explain:true (expensive at scale),
 * we reconstruct the explanation from the hit's source fields
 * and the search params stored in context.
 */
function extractRankingExplanation(hit, { lat, lon, radiusKm, targetPrice }) {
    const src = hit._source;
    const score = hit._score;

    // Geo distance normalisation (approx 0-1 from score)
    // We reconstruct proportional contributions from weights
    const totalScore = score;

    const priceOrigin = targetPrice || MEDIAN_PRICE;
    const price = src.price || priceOrigin;

    // Approximate component values using the same formulas as OS
    const geoScaleKm = Math.max(1, Math.round(radiusKm / 2));
    const hitLat = src.location?.lat || lat;
    const hitLon = src.location?.lon || lon;
    const distKm = haversineKm(lat, lon, hitLat, hitLon);
    const geoRaw = Math.exp(-0.5 * Math.pow(distKm / geoScaleKm, 2));

    const daysOld = daysSince(src.date_of_transfer);
    const recencyRaw = Math.exp(-0.5 * Math.pow(Math.max(0, daysOld - 30) / 365, 2));

    const priceDiff = Math.abs(price - priceOrigin);
    const priceRaw = Math.exp(-0.5 * Math.pow(priceDiff / (priceOrigin * 0.5), 2));

    const views = src.views_count || 0;
    const engagRaw = Math.min(1, Math.log1p(views) * 0.15);

    return {
        total_score: parseFloat(totalScore.toFixed(4)),
        geo_distance_score: parseFloat((geoRaw * 0.35).toFixed(4)),
        recency_score: parseFloat((recencyRaw * 0.25).toFixed(4)),
        price_score: parseFloat((priceRaw * 0.25).toFixed(4)),
        engagement_score: parseFloat((engagRaw * 0.15).toFixed(4)),
        distance_km: parseFloat(distKm.toFixed(2)),
        days_old: daysOld,
        views_count: views,
    };
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) { return deg * Math.PI / 180; }

function daysSince(dateStr) {
    if (!dateStr) return 9999;
    const ms = Date.now() - new Date(dateStr).getTime();
    return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

module.exports = { buildRankingQuery, extractRankingExplanation };
