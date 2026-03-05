/**
 * src/controllers/searchController.js
 * Handles radius and bounding-box geo-search via OpenSearch
 */

const { client, INDEX } = require("../services/opensearchClient");
const { buildRankingQuery, extractRankingExplanation } = require("../services/ranking");

// ──────────────────────────────────────────────────────────────────────
// Shared hit formatter
// ──────────────────────────────────────────────────────────────────────
function formatHits(hits, rankingCtx) {
    return hits.map(hit => ({
        id: hit._source.id || hit._id,
        price: hit._source.price,
        date_of_transfer: hit._source.date_of_transfer,
        property_type: hit._source.property_type,
        location: hit._source.location,
        city: hit._source.city,
        postcode: hit._source.postcode,
        bedrooms: hit._source.bedrooms,
        bathrooms: hit._source.bathrooms,
        views_count: hit._source.views_count,
        _score: hit._score,
        _ranking_explanation: extractRankingExplanation(hit, rankingCtx),
    }));
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/properties/search/radius
// ──────────────────────────────────────────────────────────────────────
async function radiusSearch(req, res) {
    const { lat, lon, radius_km, price, size } = req.query;

    const latF = parseFloat(lat);
    const lonF = parseFloat(lon);
    const radiusKm = parseInt(radius_km) || 10;
    const targetPrice = price ? parseInt(price) : null;
    const pageSize = Math.min(parseInt(size) || 50, 200);

    if (isNaN(latF) || isNaN(lonF)) {
        return res.status(400).json({ error: "lat and lon are required numeric parameters" });
    }
    if (radiusKm < 1 || radiusKm > 500) {
        return res.status(400).json({ error: "radius_km must be between 1 and 500" });
    }

    // Build geo filter for radius search
    const geoFilter = {
        geo_distance: {
            distance: `${radiusKm}km`,
            location: { lat: latF, lon: lonF },
        },
    };

    const query = buildRankingQuery({
        geoFilter,
        lat: latF,
        lon: lonF,
        radiusKm,
        targetPrice,
        size: pageSize,
    });

    try {
        const { body } = await client.search({ index: INDEX, body: query });
        const hits = body.hits?.hits || [];
        const rankCtx = { lat: latF, lon: lonF, radiusKm, targetPrice };

        return res.json({
            total: body.hits?.total?.value || 0,
            search_type: "radius",
            params: { lat: latF, lon: lonF, radius_km: radiusKm, target_price: targetPrice },
            hits: formatHits(hits, rankCtx),
        });
    } catch (err) {
        console.error("radiusSearch error:", err.message);
        return res.status(500).json({ error: "Search failed", message: err.message });
    }
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/properties/search/bbox
// ──────────────────────────────────────────────────────────────────────
async function bboxSearch(req, res) {
    const { top_left_lat, top_left_lon, bottom_right_lat, bottom_right_lon, price, size } = req.query;

    const tlLat = parseFloat(top_left_lat);
    const tlLon = parseFloat(top_left_lon);
    const brLat = parseFloat(bottom_right_lat);
    const brLon = parseFloat(bottom_right_lon);

    if ([tlLat, tlLon, brLat, brLon].some(isNaN)) {
        return res.status(400).json({
            error: "top_left_lat, top_left_lon, bottom_right_lat, bottom_right_lon are required numeric parameters",
        });
    }
    if (tlLat <= brLat) {
        return res.status(400).json({ error: "top_left_lat must be greater than bottom_right_lat" });
    }

    // Compute centre of bbox for ranking context
    const centLat = (tlLat + brLat) / 2;
    const centLon = (tlLon + brLon) / 2;
    const latDiff = Math.abs(tlLat - brLat);
    const lonDiff = Math.abs(brLon - tlLon);
    const radiusKm = Math.round(Math.sqrt(latDiff ** 2 + lonDiff ** 2) * 111 / 2);
    const targetPrice = price ? parseInt(price) : null;
    const pageSize = Math.min(parseInt(size) || 50, 200);

    // Build geo filter for bounding box search
    const geoFilter = {
        geo_bounding_box: {
            location: {
                top_left: { lat: tlLat, lon: tlLon },
                bottom_right: { lat: brLat, lon: brLon },
            },
        },
    };

    const query = buildRankingQuery({
        geoFilter,
        lat: centLat,
        lon: centLon,
        radiusKm,
        targetPrice,
        size: pageSize,
    });

    try {
        const { body } = await client.search({ index: INDEX, body: query });
        const hits = body.hits?.hits || [];
        const rankCtx = { lat: centLat, lon: centLon, radiusKm, targetPrice };

        return res.json({
            total: body.hits?.total?.value || 0,
            search_type: "bbox",
            params: {
                top_left: { lat: tlLat, lon: tlLon },
                bottom_right: { lat: brLat, lon: brLon },
                target_price: targetPrice,
            },
            hits: formatHits(hits, rankCtx),
        });
    } catch (err) {
        console.error("bboxSearch error:", err.message);
        return res.status(500).json({ error: "Search failed", message: err.message });
    }
}

module.exports = { radiusSearch, bboxSearch };
