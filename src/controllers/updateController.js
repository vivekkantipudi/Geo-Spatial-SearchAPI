/**
 * src/controllers/updateController.js
 * Handles property updates and NGINX cache invalidation
 */

const { client, INDEX } = require("../services/opensearchClient");
const pgPool = require("../services/pgClient");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const CACHE_DIR = process.env.NGINX_CACHE_DIR || "/var/cache/nginx";

// ──────────────────────────────────────────────────────────────────────
// POST /api/properties/:id/update
// Body: { price?, date_of_transfer?, property_type?, city?, views_count? }
// ──────────────────────────────────────────────────────────────────────
async function updateProperty(req, res) {
    const { id } = req.params;
    const updates = req.body;

    if (!id) {
        return res.status(400).json({ error: "Property id is required" });
    }

    const allowedFields = ["price", "date_of_transfer", "property_type", "city", "views_count", "bedrooms", "bathrooms"];
    const filteredUpdates = Object.fromEntries(
        Object.entries(updates).filter(([k]) => allowedFields.includes(k))
    );

    if (Object.keys(filteredUpdates).length === 0) {
        return res.status(400).json({ error: "No valid fields to update", allowed: allowedFields });
    }

    try {
        // ── 1. Update PostgreSQL ─────────────────────────────────────────
        const setClauses = Object.keys(filteredUpdates)
            .map((key, i) => `${key} = $${i + 2}`)
            .join(", ");
        const pgValues = [id, ...Object.values(filteredUpdates)];

        const pgResult = await pgPool.query(
            `UPDATE properties SET ${setClauses} WHERE id = $1 RETURNING id`,
            pgValues
        );

        if (pgResult.rowCount === 0) {
            return res.status(404).json({ error: `Property '${id}' not found in database` });
        }

        // ── 2. Update OpenSearch ─────────────────────────────────────────
        await client.update({
            index: INDEX,
            id,
            body: { doc: filteredUpdates },
            retry_on_conflict: 3,
        });

        // ── 3. Invalidate NGINX cache ────────────────────────────────────
        // Strategy: delete all cache files to force MISS on next search
        // The cache volume is shared via Docker volume mount
        let cacheCleared = false;
        try {
            clearNginxCache(CACHE_DIR);
            cacheCleared = true;
        } catch (cacheErr) {
            console.warn("Cache clear warning:", cacheErr.message);
        }

        return res.json({
            success: true,
            id,
            updated: filteredUpdates,
            cache_cleared: cacheCleared,
            message: `Property '${id}' updated. Cache ${cacheCleared ? "invalidated" : "not cleared (may still serve stale)"}`,
        });

    } catch (err) {
        console.error("updateProperty error:", err.message);
        if (err.meta?.statusCode === 404) {
            return res.status(404).json({ error: `Property '${id}' not found in OpenSearch` });
        }
        return res.status(500).json({ error: "Update failed", message: err.message });
    }
}

// ──────────────────────────────────────────────────────────────────────
// Cache invalidation helper
// Recursively deletes all files in the NGINX cache directory
// The cache volume is shared between backend and nginx containers
// ──────────────────────────────────────────────────────────────────────
function clearNginxCache(dir) {
    if (!fs.existsSync(dir)) {
        console.log(`Cache directory '${dir}' does not exist or is not mounted`);
        return;
    }

    let deleted = 0;
    function recurse(current) {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                recurse(fullPath);
            } else {
                try {
                    fs.unlinkSync(fullPath);
                    deleted++;
                } catch { /* permission issues — skip */ }
            }
        }
    }

    recurse(dir);
    console.log(`NGINX cache cleared: ${deleted} file(s) deleted from ${dir}`);
}

module.exports = { updateProperty };
