import Anthropic from "@anthropic-ai/sdk";
import { writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ─── State persistence ────────────────────────────────────────────────────────
// Skill, agent and environment are created once and reused across runs.

const STATE_FILE = path.join(import.meta.dir, ".giacomelli-state.json");

interface State {
  skillId: string;
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

// ─── Cleanup helpers ──────────────────────────────────────────────────────────

async function cleanupExisting(client: Anthropic, state: State): Promise<void> {
  console.log("Cleaning up existing agent and environment...");

  // Archive agent
  try {
    await (client.beta.agents as any).archive(state.agentId);
    console.log(`  Archived agent: ${state.agentId}`);
  } catch (e: any) {
    console.log(`  Agent ${state.agentId} already gone or archived: ${e?.message}`);
  }

  // Delete environment
  try {
    await (client.beta.environments as any).delete(state.environmentId);
    console.log(`  Deleted environment: ${state.environmentId}`);
  } catch (e: any) {
    console.log(`  Environment ${state.environmentId} already gone: ${e?.message}`);
  }
}

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Anthropic();

// ─── Skill upload ─────────────────────────────────────────────────────────────
// Skills beta header must be sent explicitly — not auto-set by SDK.

const SKILL_DIR = path.join(import.meta.dir, "giacomelli-property-scraper");
const SKILLS_BETA = "skills-2025-10-02";
const AGENTS_BETA = "managed-agents-2026-04-01";

async function uploadSkill(): Promise<string> {
  console.log("Uploading skill from skill-giacomelli/...");

  const fileNames = await readdir(SKILL_DIR);
  const files: Anthropic.Uploadable[] = [];

  for (const name of fileNames) {
    const filePath = path.join(SKILL_DIR, name);
    const content = await readFile(filePath);
    // SDK expects Uploadable — use a File-like object
    files.push(new File([content], `giacomelli-property-scraper/${name}`, {
      type: name.endsWith(".md") ? "text/markdown" : "application/javascript",
    }) as unknown as Anthropic.Uploadable);
  }

  const skill = await (client.beta.skills as any).create(
    { display_title: "Giacomelli Property Scraper", files },
    { headers: { "anthropic-beta": `${SKILLS_BETA},${AGENTS_BETA}` } },
  );

  console.log(`  Created skill: ${skill.id}`);
  return skill.id as string;
}

// ─── Bootstrap: skill + agent + environment ───────────────────────────────────

let state = await loadState();

if (state) {
  // Clean up old agent/env before creating fresh ones with the updated skill
  await cleanupExisting(client, state);
}

console.log("Creating skill, agent, and environment...");

const skillId = await uploadSkill();

const agent = await client.beta.agents.create({
  name: "Giacomelli Property Scraper",
  model: "claude-haiku-4-5-20251001",
  system:
    "You are a web scraping agent. A skill called 'giacomelli-property-scraper' is available to you. " +
    "Follow the skill instructions exactly: install Playwright, create package.json, run giacomelli-scraper.js. " +
    "Do NOT modify the script.",
  tools: [{ type: "agent_toolset_20260401" }],
  skills: [{ type: "custom", skill_id: skillId }],
} as any);
console.log(`Created agent: ${agent.id} (model: claude-haiku-4-5-20251001, skill: ${skillId})`);

const environment = await client.beta.environments.create({
  name: "giacomelli-scraper-env",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
});
console.log(`Created environment: ${environment.id}`);

state = { skillId, agentId: agent.id, environmentId: environment.id };
await saveState(state);
console.log(`State saved to ${STATE_FILE}`);

// ─── Session runner ───────────────────────────────────────────────────────────

async function runSession(title: string): Promise<void> {
  const task =
    "Use the giacomelli-property-scraper skill to extract all residential property listings " +
    "from the Giacomelli website. Follow the skill instructions step by step and save the output " +
    "to /mnt/session/outputs/giacomelli_properties.json.";

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

  const stream = await client.beta.sessions.events.stream(session.id);

  // Send task — try define_outcome (Research Preview), fall back to user.message
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
# Scraping Task Rubric
## Correctness
- giacomelli-scraper.js is run without modification
- Output file /mnt/session/outputs/giacomelli_properties.json exists and contains valid JSON
- At least 100 properties are extracted
## Completeness
- Metadata includes extraction_date and properties_extracted count
- Properties array contains url, rental_price_brl, area_sqm, bedrooms, location
            `.trim(),
          },
          max_iterations: 2,
        } as any],
      },
      {
        headers: {
          "anthropic-beta": `${AGENTS_BETA},managed-agents-2026-04-01-research-preview`,
        },
      },
    );
    usingOutcome = true;
    console.log(`[${title}] Outcome defined.`);
  } catch (err: any) {
    if (err?.status === 400 && err?.message?.includes("beta")) {
      console.warn(`[${title}] define_outcome unavailable — using user.message`);
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: "user.message", content: [{ type: "text", text: task }] }],
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
        break;
      case "span.outcome_evaluation_start":
        console.log(`[${title}] Eval iteration ${(event as any).iteration}`);
        break;
      case "span.outcome_evaluation_ongoing":
        process.stdout.write(".");
        break;
      case "span.outcome_evaluation_end": {
        const ev = event as any;
        console.log(`\n[${title}] Eval result: ${ev.result}`);
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

  // Download output files
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

      if (filename.endsWith(".json")) {
        try {
          const parsed = JSON.parse(buffer.toString("utf-8"));
          const meta = parsed.metadata ?? {};
          const summary = parsed.summary ?? {};
          console.log(`\n── ${filename} summary ──`);
          console.log(`  Extraction date  : ${meta.extraction_date}`);
          console.log(`  Properties found : ${meta.properties_extracted} / ${meta.total_properties_on_site}`);
          console.log(`  By type          : ${JSON.stringify(summary.by_type ?? {})}`);
          console.log(`  Price range      : ${summary.price_range?.min} – ${summary.price_range?.max}`);
          console.log(`  Average price    : ${summary.price_range?.average}`);
          const rootCopy = path.join(import.meta.dir, "giacomelli_properties.json");
          await writeFile(rootCopy, buffer);
          console.log(`  Root copy saved  : giacomelli_properties.json`);
        } catch { /* skip */ }
      }
    }
  }

  if (usingOutcome) {
    const retrieved = await client.beta.sessions.retrieve(session.id);
    const evaluations = (retrieved as any).outcome_evaluations ?? [];
    for (const oe of evaluations) {
      console.log(`[${title}] Outcome: ${oe.outcome_id} → ${oe.result}`);
    }
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

await runSession("giacomelli-scrape");

console.log("\nSession complete. Check outputs/ and giacomelli_properties.json.");
