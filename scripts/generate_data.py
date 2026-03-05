#!/usr/bin/env python3
"""
generate_data.py
Generates 200,000+ synthetic UK property records and saves to /app/data/properties.csv
Uses realistic log-normal price distribution clustered around UK cities.
"""

import csv
import os
import random
import uuid
from datetime import date, timedelta

import numpy as np  # type: ignore[import-untyped]

OUTPUT_PATH = "/app/data/properties.csv"
TOTAL_RECORDS = 210_000  # slight buffer above 200k

# UK city clusters: (name, lat, lon, radius_deg, weight)
CLUSTERS = [
    ("London",      51.5074, -0.1278,  0.50, 0.30),
    ("Manchester",  53.4808, -2.2426,  0.35, 0.12),
    ("Birmingham",  52.4862, -1.8904,  0.30, 0.10),
    ("Leeds",       53.8008, -1.5491,  0.25, 0.08),
    ("Sheffield",   53.3811, -1.4701,  0.25, 0.07),
    ("Liverpool",   53.4084, -2.9916,  0.25, 0.07),
    ("Bristol",     51.4545, -2.5879,  0.25, 0.06),
    ("Edinburgh",   55.9533, -3.1883,  0.30, 0.05),
    ("Cardiff",     51.4816, -3.1791,  0.20, 0.04),
    ("Nottingham",  52.9548, -1.1581,  0.20, 0.04),
    ("Leicester",   52.6369, -1.1398,  0.20, 0.04),
    ("Coventry",    52.4068, -1.5197,  0.20, 0.03),
    ("Rural",       52.5,    -1.5,     2.00, 0.06),  # spread rural
]

PROPERTY_TYPES = ["Detached", "Semi-Detached", "Terraced", "Flat", "Bungalow"]
TYPE_WEIGHTS   = [0.20, 0.30, 0.25, 0.20, 0.05]

CITY_NAMES = [c[0] for c in CLUSTERS if c[0] != "Rural"] + ["Rural Area"]


def pick_cluster():
    weights = [c[4] for c in CLUSTERS]
    total = sum(weights)
    r = random.random() * total
    cumulative = 0
    for c in CLUSTERS:
        cumulative += c[4]
        if r <= cumulative:
            return c
    return CLUSTERS[-1]


def generate_location(cluster):
    _, lat, lon, radius, _ = cluster
    # Sample from bivariate normal centred on cluster
    dlat = np.random.normal(0, radius * 0.4)
    dlon = np.random.normal(0, radius * 0.4)
    return round(lat + dlat, 6), round(lon + dlon, 6)


def generate_price(cluster):
    # London prices higher; log-normal distribution
    base_mean = {
        "London": 520_000,
        "Edinburgh": 310_000,
        "Bristol": 340_000,
        "Manchester": 260_000,
        "Birmingham": 240_000,
        "Leeds": 230_000,
        "Sheffield": 200_000,
        "Liverpool": 210_000,
        "Cardiff": 220_000,
        "Nottingham": 215_000,
        "Leicester": 220_000,
        "Coventry": 225_000,
        "Rural": 280_000,
    }.get(cluster[0], 250_000)

    sigma = 0.55
    mu = np.log(base_mean) - (sigma ** 2) / 2
    price = int(np.random.lognormal(mu, sigma))
    # Clamp to realistic range
    return max(50_000, min(price, 5_000_000))


def generate_date():
    start = date(2010, 1, 1)
    end   = date(2024, 12, 31)
    delta = (end - start).days
    return start + timedelta(days=random.randint(0, delta))


def generate_views():
    # Engagement: power-law distribution (most properties have few views)
    return int(np.random.pareto(1.5) * 50) + random.randint(0, 20)


def main():
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)

    _rng = np.random.default_rng(42)  # noqa: F841 – seeded for reproducibility
    random.seed(42)
    np.random.seed(42)

    fields = [
        "id", "price", "date_of_transfer", "property_type",
        "lat", "lon", "city", "postcode", "views_count", "bedrooms", "bathrooms"
    ]

    print(f"Generating {TOTAL_RECORDS:,} synthetic property records …")

    with open(OUTPUT_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()

        for i in range(TOTAL_RECORDS):
            cluster   = pick_cluster()
            lat, lon  = generate_location(cluster)
            price     = generate_price(cluster)
            prop_type = random.choices(PROPERTY_TYPES, weights=TYPE_WEIGHTS, k=1)[0]
            bedrooms  = random.choices([1, 2, 3, 4, 5], weights=[0.15, 0.30, 0.30, 0.18, 0.07], k=1)[0]
            bathrooms = max(1, min(bedrooms, random.randint(1, 3)))
            city_name = cluster[0] if cluster[0] != "Rural" else "Rural Area"

            # Synthetic UK-style postcode
            letters = "ABCDEFGHJKLMNPRSTUVWXY"
            postcode = (
                f"{random.choice(letters)}{random.choice(letters)}"
                f"{random.randint(1,20)} "
                f"{random.randint(1,9)}"
                f"{random.choice(letters)}{random.choice(letters)}"
            )

            writer.writerow({
                "id":               str(uuid.uuid4()),
                "price":            price,
                "date_of_transfer": generate_date().isoformat(),
                "property_type":    prop_type,
                "lat":              lat,
                "lon":              lon,
                "city":             city_name,
                "postcode":         postcode,
                "views_count":      generate_views(),
                "bedrooms":         bedrooms,
                "bathrooms":        bathrooms,
            })

            if (i + 1) % 10_000 == 0:
                print(f"  … {i+1:,} / {TOTAL_RECORDS:,} records written")

    print(f"Done. Data saved to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
