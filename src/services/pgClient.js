/**
 * src/services/pgClient.js
 * Shared PostgreSQL connection pool
 */

const { Pool } = require("pg");

const pool = new Pool({
    host: process.env.POSTGRES_HOST || "db",
    port: parseInt(process.env.POSTGRES_PORT || "5432"),
    user: process.env.POSTGRES_USER || "geouser",
    password: process.env.POSTGRES_PASSWORD || "geopassword",
    database: process.env.POSTGRES_DB || "geodb",
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => console.error("Unexpected PG pool error", err));

module.exports = pool;
