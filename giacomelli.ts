import Anthropic from "@anthropic-ai/sdk";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ─── State persistence ────────────────────────────────────────────────────────
// Agent and environment are created once and reused across runs.
// Their IDs are persisted in .giacomelli-state.json next to this file.

const STATE_FILE = path.join(import.meta.dir, ".giacomelli-state.json");

interface State {
  agentId: string;
  environmentId: string;
}

async function loadState(): Promise<State | null> {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function saveState(state: State): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Task ─────────────────────────────────────────────────────────────────────
// The agent receives the pre-built scraper skill (giacomelli-scraper.js) as a
// file upload and simply installs Playwright, then runs the script.
// No exploration or script writing needed — the skill is fully self-contained.

const SCRAPER_PATH = path.join(import.meta.dir, "giacomelli-scraper.js");
const SCRAPER_SOURCE = await Bun.file(SCRAPER_PATH).text();

const TASK = `
## Your task
Run the property scraper skill to extract all residential listings from the Giacomelli website and save the results to \`/mnt/session/outputs/giacomelli_properties.json\`.

## The scraper skill
Save the following content as \`giacomelli-scraper.js\` and run it with Node.js.
The script is fully self-contained — do NOT modify it.

\`\`\`javascript
${SCRAPER_SOURCE}
\`\`\`

## Steps — execute in order, no investigation needed

### 1. Install Playwright (skip if already present)
\`\`\`bash
npm install playwright && npx playwright install chromium && echo "ready"
\`\`\`

### 2. Save the scraper and add a package.json so Node treats it as ESM
\`\`\`bash
echo '{"type":"module"}' > package.json
\`\`\`

### 3. Run the scraper
\`\`\`bash
node giacomelli-scraper.js /mnt/session/outputs/giacomelli_properties.json
\`\`\`

### 4. Confirm
Print the first few lines of the output file to confirm it is valid JSON with properties.
Do NOT rewrite or debug the script — it is already correct and tested locally.
`.trim();

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Anthropic();

// ─── Ensure agent & environment exist (create once, reuse forever) ────────────

let state = await loadState();

if (state) {
  console.log(`Reusing agent: ${state.agentId}`);
  console.log(`Reusing environment: ${state.environmentId}`);
} else {
  console.log("First run — creating agent and environment...");

  const agent = await client.beta.agents.create({
    name: "Giacomelli Property Scraper",
    model: "claude-haiku-4-5-20251001",
    system:
      "You are a web scraping agent. You receive a ready-made Node.js scraper script. " +
      "Your only job is to install Playwright, save the script to disk, run it, and confirm the output file exists. " +
      "Do NOT rewrite or modify the script.",
    tools: [{ type: "agent_toolset_20260401" }],
  });
  console.log(`Created agent: ${agent.id} (v${agent.version})`);

  const environment = await client.beta.environments.create({
    name: "giacomelli-scraper-env",
    config: {
      type: "cloud",
      networking: { type: "unrestricted" }, // needs internet access for the website
    },
  });
  console.log(`Created environment: ${environment.id}`);

  state = { agentId: agent.id, environmentId: environment.id };
  await saveState(state);
  console.log(`State saved to ${STATE_FILE}`);
}

// ─── Session runner ───────────────────────────────────────────────────────────

async function runSession(title: string, task: string): Promise<void> {
  const session = await client.beta.sessions.create({
    agent: state!.agentId,
    environment_id: state!.environmentId,
    title,
  });

  const sessionDir = path.join(import.meta.dir, "outputs", session.id);
  await mkdir(sessionDir, { recursive: true });

  console.log(`\n${"─".repeat(60)}`);
  console.log(`[${title}] Session: ${session.id}`);
  console.log(`[${title}] Output dir: outputs/${session.id}/`);

  // Open the event stream
  const stream = await client.beta.sessions.events.stream(session.id);

  // Send work instruction — try define_outcome (Research Preview), fall back to message
  let usingOutcome = false;
  try {
    await client.beta.sessions.events.send(
      session.id,
      {
        events: [{
          type: "user.define_outcome",
          description: task,
          rubric: {
            type: "text",
            content: `
# Web Scraping Task Rubric

## Correctness
- The script successfully navigates to the Giacomelli website
- All available properties are loaded (including paginated ones via "Carregar mais")
- Each property record contains: url, property_type, code, rental_price_brl, area_sqm, bedrooms, location

## Output File
- Output is saved to /mnt/session/outputs/giacomelli_properties.json
- File contains valid JSON with metadata and properties array
- At least 1 property is extracted (ideally all available)

## Code Quality
- Playwright is properly installed and used
- Errors are handled gracefully
- Summary statistics are printed to console
            `.trim(),
          },
          max_iterations: 3,
        } as any],
      },
      {
        headers: {
          "anthropic-beta": "managed-agents-2026-04-01,managed-agents-2026-04-01-research-preview",
        },
      },
    );
    usingOutcome = true;
    console.log(`[${title}] Outcome defined — agent iterating toward rubric...`);
  } catch (err: any) {
    if (err?.status === 400 && err?.message?.includes("beta")) {
      console.warn(`[${title}] define_outcome not available (Research Preview required) — using user.message`);
      await client.beta.sessions.events.send(session.id, {
        events: [{
          type: "user.message",
          content: [{ type: "text", text: task }],
        }],
      });
    } else {
      throw err;
    }
  }

  // Stream events
  for await (const event of stream) {
    switch (event.type) {
      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") process.stdout.write(`[${title}] ${block.text}`);
        }
        break;
      case "agent.tool_use":
        console.log(`\n[${title}] Tool: ${event.name}`);
        break;
      case "agent.tool_result":
        break; // silent
      case "span.outcome_evaluation_start":
        console.log(`[${title}] Outcome eval iteration ${(event as any).iteration} started`);
        break;
      case "span.outcome_evaluation_ongoing":
        process.stdout.write(".");
        break;
      case "span.outcome_evaluation_end": {
        const ev = event as any;
        console.log(`\n[${title}] Outcome eval result: ${ev.result}`);
        if (ev.explanation) console.log(`[${title}]   ${ev.explanation}`);
        break;
      }
      case "session.error":
        console.error(`[${title}] Session error:`, JSON.stringify((event as any).error));
        break;
      case "session.status_idle":
        console.log(`\n[${title}] Agent finished.`);
        break;
      default:
        break;
    }
    if (event.type === "session.status_idle") break;
  }

  // Download deliverables into outputs/<sessionId>/
  console.log(`[${title}] Fetching output files...`);

  const files = await client.beta.files.list(
    { scope_id: session.id },
    {
      headers: {
        "anthropic-beta": "files-api-2025-04-14,managed-agents-2026-04-01,managed-agents-2026-04-01-research-preview",
      },
    },
  );

  if (!files.data.length) {
    console.log(`[${title}] No output files found.`);
  } else {
    for (const f of files.data) {
      const filename = (f as any).filename ?? `${f.id}.bin`;
      const dest = path.join(sessionDir, filename);
      const response = await client.beta.files.download(f.id);
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(dest, buffer);
      console.log(`[${title}] Downloaded → outputs/${session.id}/${filename} (${buffer.length} bytes)`);

      // Print JSON summary without flooding the console
      if (filename.endsWith(".json")) {
        try {
          const parsed = JSON.parse(buffer.toString("utf-8"));
          const meta = parsed.metadata ?? {};
          const summary = parsed.summary ?? {};
          console.log(`\n── ${filename} summary ──`);
          console.log(`  Extraction date  : ${meta.extraction_date}`);
          console.log(`  Properties found : ${meta.properties_extracted} / ${meta.total_properties_on_site} on site`);
          console.log(`  By type          : ${JSON.stringify(summary.by_type ?? {})}`);
          console.log(`  Price range      : ${summary.price_range?.min} – ${summary.price_range?.max}`);
          console.log(`  Average price    : ${summary.price_range?.average}`);
          // Also save a copy at the project root for quick access
          const rootCopy = path.join(import.meta.dir, "giacomelli_properties.json");
          await writeFile(rootCopy, buffer);
          console.log(`  Root copy saved  : giacomelli_properties.json`);
        } catch {
          // not valid JSON, skip summary
        }
      }
    }
  }

  if (usingOutcome) {
    const retrieved = await client.beta.sessions.retrieve(session.id);
    const evaluations = (retrieved as any).outcome_evaluations ?? [];
    if (evaluations.length) {
      console.log(`[${title}] Outcome evaluations:`);
      for (const oe of evaluations) {
        console.log(`[${title}]   ${oe.outcome_id}: ${oe.result}`);
      }
    }
  }
}

// ─── Run the scraping session ─────────────────────────────────────────────────

await runSession("giacomelli-scrape", TASK);

console.log("\nSession complete. Check outputs/ for the raw files and giacomelli_properties.json at the project root.");
