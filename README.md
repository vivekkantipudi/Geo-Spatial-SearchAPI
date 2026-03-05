# Geo-Spatial Search API

A high-performance geo-spatial property search API combining **PostgreSQL/PostGIS**, **OpenSearch**, and **NGINX** for fast, ranked location-based search. Fully containerised with Docker Compose.

---

## Architecture

```
Client
  │
  ▼
NGINX (port 80)          ← rate limiting + response caching
  │
  ▼
Backend API (Node.js)    ← Express REST API, ranking logic
  ├── OpenSearch          ← geo-queries + function_score ranking
  └── PostgreSQL/PostGIS  ← persistent store + GIST spatial index

[Ingestion Container]    ← one-shot: generate 210k records → load both stores
```

---

## Quick Start

### Prerequisites
- Docker & Docker Compose v2+
- (Optional) k6 for load testing: https://k6.io/docs/getting-started/installation/

### 1. Clone and configure
```bash
git clone <repo-url>
cd Geo-Spatial-SearchAPI
cp .env.example .env
```

### 2. Start everything
```bash
docker-compose up -d --build
```

This will:
1. Start PostgreSQL/PostGIS and OpenSearch
2. Run the **ingestion container** (generates 210,000 property records, loads into both stores) — takes ~5–8 minutes
3. Start the **backend API** (waits for ingestion to complete)
4. Start **NGINX** reverse proxy

### 3. Verify startup

```bash
# Check all containers are healthy
docker-compose ps

# Check PostgreSQL record count (should be >= 200,000)
docker-compose exec db psql -U geouser -d geodb -c "SELECT COUNT(*) FROM properties;"

# Check OpenSearch document count
curl http://localhost:9200/_cat/indices/properties?v

# Check OpenSearch geo_point mapping
curl http://localhost:9200/properties/_mapping | python -m json.tool
```

---

## API Reference

All endpoints are served through NGINX at `http://localhost/api/properties/`.

### `GET /api/properties/search/radius`

Search for properties within a radius of a coordinate.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lat` | float | ✓ | Centre latitude |
| `lon` | float | ✓ | Centre longitude |
| `radius_km` | int | ✓ | Search radius (1–500 km) |
| `price` | int | ✗ | Target price for price scoring |
| `size` | int | ✗ | Max results (default: 50, max: 200) |

```bash
curl "http://localhost/api/properties/search/radius?lat=51.5074&lon=-0.1278&radius_km=10"
```

**Response:**
```json
{
  "total": 1250,
  "search_type": "radius",
  "params": { "lat": 51.5074, "lon": -0.1278, "radius_km": 10, "target_price": null },
  "hits": [
    {
      "id": "uuid",
      "price": 485000,
      "date_of_transfer": "2024-03-15",
      "property_type": "Flat",
      "location": { "lat": 51.51, "lon": -0.12 },
      "city": "London",
      "postcode": "EC1A 1BB",
      "bedrooms": 2,
      "bathrooms": 1,
      "views_count": 340,
      "_score": 0.8432,
      "_ranking_explanation": {
        "total_score": 0.8432,
        "geo_distance_score": 0.3412,
        "recency_score": 0.2314,
        "price_score": 0.1987,
        "engagement_score": 0.0719,
        "distance_km": 0.87,
        "days_old": 354,
        "views_count": 340
      }
    }
  ]
}
```

---

### `GET /api/properties/search/bbox`

Search within a rectangular bounding box.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `top_left_lat` | float | ✓ | Top-left corner latitude |
| `top_left_lon` | float | ✓ | Top-left corner longitude |
| `bottom_right_lat` | float | ✓ | Bottom-right corner latitude |
| `bottom_right_lon` | float | ✓ | Bottom-right corner longitude |
| `price` | int | ✗ | Target price |
| `size` | int | ✗ | Max results (default: 50) |

```bash
curl "http://localhost/api/properties/search/bbox?top_left_lat=51.7&top_left_lon=-0.5&bottom_right_lat=51.3&bottom_right_lon=0.2"
```

---

### `POST /api/properties/:id/update`

Update a property and invalidate the NGINX cache.

```bash
curl -X POST http://localhost/api/properties/<uuid>/update \
  -H "Content-Type: application/json" \
  -d '{"price": 550000}'
```

**Response:**
```json
{
  "success": true,
  "id": "uuid",
  "updated": { "price": 550000 },
  "cache_cleared": true,
  "message": "Property 'uuid' updated. Cache invalidated"
}
```

---

## NGINX Features

### Caching
- Responses for `GET /api/properties/search/*` are cached for **10 minutes**
- Cache key: `$scheme$request_method$host$request_uri`
- Check the `X-Cache-Status` response header: `MISS` on first request, `HIT` on subsequent identical requests

```bash
# First request
curl -I "http://localhost/api/properties/search/radius?lat=51.5&lon=-0.1&radius_km=5"
# X-Cache-Status: MISS

# Same request again
curl -I "http://localhost/api/properties/search/radius?lat=51.5&lon=-0.1&radius_km=5"
# X-Cache-Status: HIT
```

### Rate Limiting
- 60 requests per minute per IP
- Burst of 10 allowed without delay
- Exceeding the limit returns **HTTP 429**
- Response headers: `X-RateLimit-Limit: 60`

---

## Ranking Algorithm

Search results are ranked using a weighted `function_score` query in OpenSearch:

| Factor | Weight | Method |
|--------|--------|--------|
| Geo-distance | 35% | Gaussian decay (scale = radius/2) |
| Recency | 25% | Gaussian decay (scale = 365 days) |
| Price match | 25% | Exponential decay from target price |
| Engagement | 15% | log1p(views_count) × 0.15 |

Each result includes a `_ranking_explanation` object breaking down the score components.

---

## Database Schema

**PostgreSQL (`properties` table):**

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PRIMARY KEY |
| price | INTEGER | NOT NULL |
| date_of_transfer | DATE | NOT NULL |
| property_type | VARCHAR(50) | |
| location | GEOMETRY(Point, 4326) | PostGIS, GIST-indexed |
| city | VARCHAR(100) | |
| postcode | VARCHAR(20) | |
| views_count | INTEGER | |
| bedrooms | SMALLINT | |
| bathrooms | SMALLINT | |

**OpenSearch index mapping:**
- `location` → `geo_point`
- `date_of_transfer` → `date`
- `price` → `integer`

---

## Load Testing

```bash
# Install k6: https://k6.io/docs/getting-started/installation/

# Run load test (cache enabled — default)
k6 run tests/load-test.js

# Run against localhost
k6 run -e BASE_URL=http://localhost tests/load-test.js

# Disable cache first, then run comparison
# Comment out proxy_cache lines in nginx/nginx.conf, then:
docker-compose restart nginx
k6 run -e TAG=no-cache tests/load-test.js
```

See [`reports/performance.md`](reports/performance.md) for the full performance comparison.

---

## Environment Variables

Copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_USER` | `geouser` | DB username |
| `POSTGRES_PASSWORD` | `geopassword` | DB password |
| `POSTGRES_DB` | `geodb` | Database name |
| `POSTGRES_HOST` | `db` | DB host (Docker service name) |
| `POSTGRES_PORT` | `5432` | DB port |
| `OPENSEARCH_URL` | `http://opensearch:9200` | OpenSearch connection URL |
| `OPENSEARCH_INDEX` | `properties` | Index name |
| `APP_PORT` | `3000` | Backend listen port |
| `NODE_ENV` | `production` | Node environment |
| `NGINX_CACHE_DIR` | `/var/cache/nginx` | Cache volume path |

---

## Directory Structure

```
Geo-Spatial-SearchAPI/
├── docker-compose.yml        # Orchestrates all services
├── Dockerfile                # Backend Node.js image
├── .env.example              # Environment variable template
├── package.json              # Backend dependencies
├── nginx/
│   └── nginx.conf            # NGINX caching + rate limiting config
├── scripts/
│   ├── generate_data.py      # Generates 210k synthetic property records
│   ├── ingest.js             # Loads CSV → PostgreSQL + OpenSearch
│   ├── package.json          # Ingestion script dependencies
│   ├── requirements.txt      # Python dependencies
│   └── Dockerfile.ingestion  # One-shot ingestion container
├── src/
│   ├── index.js              # Express app entry point
│   ├── routes/
│   │   └── properties.js     # Route definitions
│   ├── controllers/
│   │   ├── searchController.js  # Radius + bbox search
│   │   └── updateController.js  # Property update + cache invalidation
│   └── services/
│       ├── opensearchClient.js  # OpenSearch singleton
│       ├── pgClient.js          # PostgreSQL pool
│       └── ranking.js           # function_score query builder + explanation
├── tests/
│   └── load-test.js          # k6 load test script
└── reports/
    └── performance.md        # Performance comparison report
```

---

## Troubleshooting

**Ingestion takes too long?**
The ingestion container generates + loads 210,000 records. This typically takes 5–10 minutes depending on hardware. Monitor with:
```bash
docker-compose logs -f ingestion
```

**OpenSearch out of memory?**
Increase heap in `docker-compose.yml`:
```yaml
OPENSEARCH_JAVA_OPTS: -Xms1g -Xmx1g
```

**Cache not working?**
Ensure the `nginx_cache` Docker volume is correctly mounted in both the `nginx` and `backend` services. The backend needs write access to delete cache files for invalidation.
