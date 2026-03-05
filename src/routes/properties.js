/**
 * src/routes/properties.js
 * Route definitions for the property search API
 */

const express = require("express");
const router = express.Router();

const { radiusSearch, bboxSearch } = require("../controllers/searchController");
const { updateProperty } = require("../controllers/updateController");

// ── Search routes ─────────────────────────────────────────────────────
// GET /api/properties/search/radius?lat=&lon=&radius_km=
router.get("/search/radius", radiusSearch);

// GET /api/properties/search/bbox?top_left_lat=&top_left_lon=&bottom_right_lat=&bottom_right_lon=
router.get("/search/bbox", bboxSearch);

// ── Update route ──────────────────────────────────────────────────────
// POST /api/properties/:id/update
router.post("/:id/update", updateProperty);

module.exports = router;
