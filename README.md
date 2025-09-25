# Bioladen.de Händlersuche – stabiler Actor

**Ziel:** Exakte Extraktion der Händlerliste von  
https://www.bioladen.de/bio-haendler-suche (PLZ + Radius).

## Features
- Steuert die Webseite per **Playwright (Crawlee)** – kein OSM, keine Fremdquellen.
- Unterstützt Filter **Bioläden**, **Marktstände**, **Lieferservice**.
- **Dedup nach `detailUrl`** (Fallback: `name+address`).
- Stabil: Warte-Strategien, Auto-Scroll, Mehrfach-Selectoren (Text & CSS).
- Output-Schema identisch mit vorherigem Projekt (wo möglich).

## Input (Sanity 20095 / 25 km)
```json
{
  "postalCodes": ["20095"],
  "radiusKm": 25,
  "filters": { "biolaeden": true, "marktstaende": true, "lieferservice": true },
  "deduplicateBy": "detailUrl",
  "maxConcurrency": 1
}
```

## Output-Schema
```text
name, street, zip, city, country, lat, lng, phone, email, website,
openingHours, detailUrl, source, scrapedAt, distanceKm, category
```

## Hinweise
- Der Actor nutzt **sichtbares Rendern** und liest aus dem DOM – robust gegen API-Änderungen.
- Für sehr große Läufe Concurrency bei 1 lassen und Rate-Limits beachten.
