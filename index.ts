import Anthropic from "@anthropic-ai/sdk";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ─── State persistence ────────────────────────────────────────────────────────
// Agent and environment are created once and reused across runs.
// Their IDs are persisted in .state.json next to this file.

const STATE_FILE = path.join(import.meta.dir, ".state.json");

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

// ─── Rubric ───────────────────────────────────────────────────────────────────

const RUBRIC = `
# Coding Task Rubric

## Correctness
- The script produces the correct output for the given task
- The output file exists and contains valid data

## Code Quality
- Code is clean, readable and well-commented
- Logic is encapsulated in functions
- No hard-coded magic numbers where variables make sense

## Output File
- Output is written to a clearly named file
- File is saved to /mnt/session/outputs/
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
    name: "Coding Assistant",
    model: "claude-sonnet-4-6",
    system: "You are a helpful coding assistant. Write clean, well-documented code.",
    tools: [{ type: "agent_toolset_20260401" }],
  });
  console.log(`Created agent: ${agent.id} (v${agent.version})`);

  const environment = await client.beta.environments.create({
    name: "coding-env",
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
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
          rubric: { type: "text", content: RUBRIC },
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
        // suppress noisy span/status events; uncomment to debug:
        // console.log(`[${title}] event: ${event.type}`);
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

      if (filename.endsWith(".txt") || filename.endsWith(".js") || filename.endsWith(".ts")) {
        console.log(`\n── outputs/${session.id}/${filename} ──`);
        console.log(buffer.toString("utf-8"));
      }
    }
  }

  // Outcome evaluation summary
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

// ─── Run two sessions ─────────────────────────────────────────────────────────

await Promise.all([
  runSession(
    "fibonacci",
    "Create a JS script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt, then run it.",
  ),
  runSession(
    "primes",
    "Create a JS script that finds all prime numbers up to 100 using the Sieve of Eratosthenes and saves them to primes.txt, then run it.",
  ),
]);

console.log("\nAll sessions complete.");
