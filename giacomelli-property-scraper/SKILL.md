---
name: giacomelli-property-scraper
description: Extracts all residential property listings from the Giacomelli real estate website (giacomelli.com.br) using Playwright. Handles virtual scrolling, authenticated proxy, RSC network interception, and saves results as structured JSON to /mnt/session/outputs/giacomelli_properties.json.
---

# Giacomelli Property Scraper

## Purpose
Extract all residential rental property listings from https://www.giacomelli.com.br and save them as structured JSON.

## Instructions

Run the included `giacomelli-scraper.js` script to perform the extraction.

### Steps

1. Install Playwright and Chromium:
```bash
npm install playwright && npx playwright install chromium && echo "ready"
```

2. Create a `package.json` so Node.js treats the script as ESM:
```bash
echo '{"type":"module"}' > package.json
```

3. Run the scraper:
```bash
node giacomelli-scraper.js /mnt/session/outputs/giacomelli_properties.json
```

4. Confirm the output file exists and print the first few lines to verify valid JSON.

## Important Notes
- Do NOT modify `giacomelli-scraper.js` — it is fully self-contained and pre-tested.
- The sandbox proxy is auto-detected from `$http_proxy` / `$HTTPS_PROXY` environment variables.
- The script uses RSC network interception to capture all batches — expected output is ~186/221 properties.
- Output is always saved to `/mnt/session/outputs/giacomelli_properties.json`.

## Expected Output
A JSON file with the following structure:
```json
{
  "metadata": { "properties_extracted": 186, "total_properties_on_site": 221 },
  "summary": { "by_type": { "APARTAMENTO": 161 }, "price_range": { "min": "R$ 1.400" } },
  "properties": [{ "id": 1, "url": "/imovel/...", "rental_price_brl": "3.700", ... }]
}
```
