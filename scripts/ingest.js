#!/usr/bin/env node
/**
 * ingest.js
 * Reads /app/data/properties.csv and bulk-loads into:
 *   1. PostgreSQL/PostGIS  – properties table (with GIST index)
 *   2. OpenSearch          – properties index (geo_point mapping)
 */

const fs       = require("fs");
const path     = require("path");
const { parse }= require("csv-parse");
const { Pool } = require("pg");
const { Client }= require("@opensearch-project/opensearch");

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────
const CSV_PATH   = "/app/data/properties.csv";
const PG_BATCH   = 2000;
const OS_BATCH   = 1000;
const INDEX_NAME = process.env.OPENSEARCH_INDEX || "properties";

const pg = new Pool({
  host:     process.env.POSTGRES_HOST     || "db",
  port:     parseInt(process.env.POSTGRES_PORT || "5432"),
  user:     process.env.POSTGRES_USER     || "geouser",
  password: process.env.POSTGRES_PASSWORD || "geopassword",
  database: process.env.POSTGRES_DB       || "geodb",
});

const os = new Client({ node: process.env.OPENSEARCH_URL || "http://opensearch:9200" });

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForPostgres() {
  for (let i = 0; i < 30; i++) {
    try {
      await pg.query("SELECT 1");
      console.log("✓ PostgreSQL ready");
      return;
    } catch { await sleep(3000); }
  }
  throw new Error("PostgreSQL not available after 90s");
}

async function waitForOpenSearch() {
  for (let i = 0; i < 40; i++) {
    try {
      await os.cluster.health({});
      console.log("✓ OpenSearch ready");
      return;
    } catch { await sleep(3000); }
  }
  throw new Error("OpenSearch not available after 120s");
}

// ──────────────────────────────────────────────
// PostgreSQL Setup
// ──────────────────────────────────────────────
async function setupPostgres() {
  await pg.query("CREATE EXTENSION IF NOT EXISTS postgis;");

  await pg.query(`
    CREATE TABLE IF NOT EXISTS properties (
      id               UUID         PRIMARY KEY,
      price            INTEGER      NOT NULL,
      date_of_transfer DATE         NOT NULL,
      property_type    VARCHAR(50),
      location         GEOMETRY(Point, 4326) NOT NULL,
      city             VARCHAR(100),
      postcode         VARCHAR(20),
      views_count      INTEGER      DEFAULT 0,
      bedrooms         SMALLINT,
      bathrooms        SMALLINT,
      created_at       TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  // GIST spatial index
  await pg.query(`
    CREATE INDEX IF NOT EXISTS idx_properties_location
    ON properties USING GIST (location);
  `);

  // Other useful indexes
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_properties_price    ON properties (price);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_properties_date     ON properties (date_of_transfer DESC);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_properties_city     ON properties (city);`);

  // Check if already ingested
  const { rows } = await pg.query("SELECT COUNT(*) AS cnt FROM properties;");
  if (parseInt(rows[0].cnt) >= 200_000) {
    console.log(`✓ PostgreSQL already contains ${rows[0].cnt} records – skipping PG ingestion`);
    return false;
  }
  return true;
}

// ──────────────────────────────────────────────
// OpenSearch Setup
// ──────────────────────────────────────────────
async function setupOpenSearch() {
  const exists = await os.indices.exists({ index: INDEX_NAME });
  if (exists.body) {
    const stats = await os.count({ index: INDEX_NAME });
    if (stats.body.count >= 200_000) {
      console.log(`✓ OpenSearch already contains ${stats.body.count} documents – skipping OS ingestion`);
      return false;
    }
    await os.indices.delete({ index: INDEX_NAME });
  }

  await os.indices.create({
    index: INDEX_NAME,
    body: {
      settings: {
        number_of_shards:   2,
        number_of_replicas: 0,
        refresh_interval:   "30s",
      },
      mappings: {
        properties: {
          id:               { type: "keyword" },
          price:            { type: "integer" },
          date_of_transfer: { type: "date", format: "yyyy-MM-dd" },
          property_type:    { type: "keyword" },
          location:         { type: "geo_point" },
          city:             { type: "keyword" },
          postcode:         { type: "keyword" },
          views_count:      { type: "integer" },
          bedrooms:         { type: "integer" },
          bathrooms:        { type: "integer" },
        },
      },
    },
  });

  console.log(`✓ OpenSearch index '${INDEX_NAME}' created with geo_point mapping`);
  return true;
}

// ──────────────────────────────────────────────
// Bulk ingestion
// ──────────────────────────────────────────────
async function ingestBatchPG(rows) {
  if (!rows.length) return;
  const vals = rows.map((r, i) => {
    const base = i * 9;
    return `($${base+1},$${base+2},$${base+3},$${base+4},ST_SetSRID(ST_MakePoint($${base+5},$${base+6}),4326),$${base+7},$${base+8},$${base+9})`;
  }).join(",");

  const params = rows.flatMap(r => [
    r.id, parseInt(r.price), r.date_of_transfer, r.property_type,
    parseFloat(r.lon), parseFloat(r.lat),
    r.city, r.postcode, parseInt(r.views_count || 0),
  ]);

  await pg.query(
    `INSERT INTO properties (id,price,date_of_transfer,property_type,location,city,postcode,views_count)
     VALUES ${vals} ON CONFLICT (id) DO NOTHING`,
    params
  );
}

async function ingestBatchOS(rows) {
  if (!rows.length) return;
  const body = rows.flatMap(r => [
    { index: { _index: INDEX_NAME, _id: r.id } },
    {
      id:               r.id,
      price:            parseInt(r.price),
      date_of_transfer: r.date_of_transfer,
      property_type:    r.property_type,
      location:         { lat: parseFloat(r.lat), lon: parseFloat(r.lon) },
      city:             r.city,
      postcode:         r.postcode,
      views_count:      parseInt(r.views_count || 0),
      bedrooms:         parseInt(r.bedrooms || 0),
      bathrooms:        parseInt(r.bathrooms || 0),
    },
  ]);

  const { body: resp } = await os.bulk({ refresh: false, body });
  if (resp.errors) {
    const errs = resp.items.filter(i => i.index?.error).slice(0, 3);
    console.warn("  ⚠ Some OS bulk errors:", JSON.stringify(errs));
  }
}

async function ingest(doPG, doOS) {
  let pgBuf  = [], osBuf = [], total = 0;

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(CSV_PATH)
      .pipe(parse({ columns: true, skip_empty_lines: true }));

    stream.on("data", async (row) => {
      stream.pause();

      if (doPG) pgBuf.push(row);
      if (doOS) osBuf.push(row);
      total++;

      // Flush PG batch
      if (pgBuf.length >= PG_BATCH) {
        const batch = pgBuf.splice(0);
        try { await ingestBatchPG(batch); }
        catch(e) { console.error("PG batch error:", e.message); }
      }
      // Flush OS batch
      if (osBuf.length >= OS_BATCH) {
        const batch = osBuf.splice(0);
        try { await ingestBatchOS(batch); }
        catch(e) { console.error("OS batch error:", e.message); }
      }

      if (total % 10_000 === 0) {
        console.log(`  … ingested ${total.toLocaleString()} rows`);
      }

      stream.resume();
    });

    stream.on("end", resolve);
    stream.on("error", reject);
  });

  // Flush remaining
  if (pgBuf.length) await ingestBatchPG(pgBuf);
  if (osBuf.length) await ingestBatchOS(osBuf);

  return total;
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────
(async () => {
  try {
    console.log("= Geo-Search Ingestion Script =");

    await waitForPostgres();
    await waitForOpenSearch();

    const doPG = await setupPostgres();
    const doOS = await setupOpenSearch();

    if (!doPG && !doOS) {
      console.log("✓ Both stores already fully populated. Exiting.");
      process.exit(0);
    }

    if (!fs.existsSync(CSV_PATH)) {
      throw new Error(`CSV not found at ${CSV_PATH} – did generate_data.py run?`);
    }

    console.log(`Starting ingestion from ${CSV_PATH} …`);
    const total = await ingest(doPG, doOS);

    // Force OS refresh
    if (doOS) await os.indices.refresh({ index: INDEX_NAME });

    console.log(`\n✓ Ingestion complete – ${total.toLocaleString()} records loaded`);

    // Final counts
    const { rows } = await pg.query("SELECT COUNT(*) AS cnt FROM properties;");
    const osCount  = (await os.count({ index: INDEX_NAME })).body.count;
    console.log(`  PostgreSQL : ${parseInt(rows[0].cnt).toLocaleString()} records`);
    console.log(`  OpenSearch : ${osCount.toLocaleString()} documents`);

    await pg.end();
    process.exit(0);
  } catch (err) {
    console.error("✗ Ingestion failed:", err.message);
    process.exit(1);
  }
})();
