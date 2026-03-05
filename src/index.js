/**
 * src/index.js
 * Express application entry point for the Geo-Spatial Search API
 */

const express = require("express");
const morgan = require("morgan");

const propertiesRouter = require("./routes/properties");

const app = express();
const PORT = parseInt(process.env.APP_PORT || "3000");

// ─── Middleware ─────────────────────────────────────────────
app.use(express.json());
app.use(morgan("combined"));

// ─── Health endpoint ────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ─── API Routes ─────────────────────────────────────────────
app.use("/api/properties", propertiesRouter);

// ─── 404 handler ────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Not Found" }));

// ─── Error handler ──────────────────────────────────────────
app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error", message: err.message });
});

// ─── Start ──────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Geo-Search API listening on port ${PORT}`);
});

module.exports = app;
