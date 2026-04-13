/**
 * giacomelli-test.ts
 *
 * Simple local test runner for the Giacomelli scraper skill.
 * Runs giacomelli-scraper.js directly via Bun shell — no managed agent overhead.
 *
 * Usage:
 *   bun giacomelli-test.ts
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SCRAPER = path.join(import.meta.dir, "giacomelli-scraper.js");
const OUTPUT  = path.join(import.meta.dir, "giacomelli_properties.json");

console.log("─".repeat(60));
console.log("Giacomelli Scraper — local test run");
console.log("─".repeat(60));

// Ensure playwright is installed
console.log("\n[test] Checking Playwright install...");
await $`npm list playwright 2>/dev/null || npm install playwright`.quiet();
await $`npx playwright install chromium --with-deps 2>/dev/null || true`.quiet();
console.log("[test] Playwright ready.");

// Run the scraper skill
console.log(`\n[test] Running: node ${SCRAPER}`);
console.log(`[test] Output:  ${OUTPUT}\n`);

const start = Date.now();
await $`node ${SCRAPER} ${OUTPUT}`;
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`\n[test] Completed in ${elapsed}s`);

// Validate output
if (!existsSync(OUTPUT)) {
  console.error("[test] FAIL — output file not found");
  process.exit(1);
}

const raw = await readFile(OUTPUT, "utf-8");
let parsed: any;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error("[test] FAIL — output is not valid JSON");
  process.exit(1);
}

const count = parsed?.metadata?.properties_extracted ?? 0;
const total = parsed?.metadata?.total_properties_on_site ?? 0;
const summary = parsed?.summary ?? {};

console.log("\n[test] ── Validation ──────────────────────────────────");
console.log(`[test] Properties extracted : ${count} / ${total} on site`);
console.log(`[test] By type              : ${JSON.stringify(summary.by_type ?? {})}`);
console.log(`[test] Price range          : ${summary.price_range?.min} – ${summary.price_range?.max}`);
console.log(`[test] Average price        : ${summary.price_range?.average}`);
console.log(`[test] File size            : ${(raw.length / 1024).toFixed(2)} KB`);

if (count === 0) {
  console.error("[test] FAIL — no properties extracted");
  process.exit(1);
}

console.log(`\n[test] PASS ✓ — ${count} properties saved to giacomelli_properties.json`);
