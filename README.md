# Claude Managed Agents Exploration

A project to explore **Claude Managed Agents** — Anthropic's fully-managed agent infrastructure where the platform handles sandboxing, state management, tool execution, and the agent loop.

## Purpose

This project demonstrates:
- **Agent lifecycle management** — create agents once, reuse them across multiple sessions
- **Environment provisioning** — cloud-based sandboxed execution with package support
- **Session management** — isolated task contexts with persistent agent state
- **Real-time streaming** — SSE-based event streaming to monitor agent progress
- **Deliverable retrieval** — download files produced by agents in the sandbox
- **Research Preview features** — optional `user.define_outcome` for rubric-based evaluation and iteration

## Architecture

### Key Components

1. **Agent** (`agent_*`)
   - Reusable AI worker configured with model, system prompt, and tools
   - Persisted in `.state.json` — created once on first run, reused thereafter
   - Tools: `agent_toolset_20260401` (built-in bash, file I/O, code execution)

2. **Environment** (`env_*`)
   - Cloud-based sandbox where agent code runs
   - Configured with unrestricted networking and all packages available
   - Persisted in `.state.json` alongside the agent

3. **Session** (`sesn_*`)
   - Isolated task context; agent can run multiple sessions sequentially or in parallel
   - Each session gets its own output folder: `outputs/<sessionId>/`
   - Bounded by `session.status_idle` (agent finished) or `session.status_terminated` (error)

4. **Events** (via `/v1/sessions/{id}/events/stream`)
   - Real-time SSE stream of agent activity
   - Published as agent runs; consumed via `client.beta.sessions.events.stream(sessionId)`

## Supported Events

### User → Agent Events (you send these)

| Type | Purpose |
|---|---|
| `user.message` | Send a task description; agent executes and responds |
| `user.define_outcome` | Send a task + rubric; agent iterates until outcome is met (Research Preview) |
| `user.interrupt` | Pause the agent mid-execution |
| `user.tool_confirmation` | Approve/deny a tool call (if agent requests permission) |

### Agent → User Events (stream emits these)

| Type | Content |
|---|---|
| `agent.message` | Text response from the agent |
| `agent.thinking` | Agent's reasoning (extended thinking) |
| `agent.tool_use` | Agent invoked a tool (bash, file read/write, etc.) |
| `agent.tool_result` | Result of tool execution |
| `agent.mcp_tool_use` | Agent used an MCP server tool |

### Session Events

| Type | Meaning |
|---|---|
| `session.status_running` | Agent is actively processing |
| `session.status_idle` | Agent finished; awaiting next input or closing session |
| `session.status_terminated` | Session ended due to unrecoverable error |
| `session.error` | Error occurred; includes `error` object with details |

### Outcome Evaluation Events (Research Preview)

| Type | Meaning |
|---|---|
| `span.outcome_evaluation_start` | Grader started evaluating iteration N |
| `span.outcome_evaluation_ongoing` | Heartbeat; grader is working |
| `span.outcome_evaluation_end` | Grader finished; result is `satisfied`, `needs_revision`, `max_iterations_reached`, `failed`, or `interrupted` |

### Observability Events

| Type | Content |
|---|---|
| `span.model_request_start` | Model inference call started |
| `span.model_request_end` | Model inference call finished; includes token usage |

## Setup

### Prerequisites

- Node.js 18+ or Bun
- Anthropic API key with Managed Agents access (automatically enabled for all accounts as of April 2026)

### Installation

```bash
bun install
# or: npm install
```

### Configuration

Create a `.env` file with your API key:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

## Usage

### First Run

Creates the agent and environment (cached in `.state.json`), then runs 2 demo sessions in parallel:

```bash
bun run index.ts
```

Output:
- Agent and environment IDs saved to `.state.json`
- Session 1: Fibonacci numbers → `outputs/<session1>/fibonacci.txt`
- Session 2: Prime numbers → `outputs/<session2>/primes.txt`

### Subsequent Runs

Reuses the same agent and environment; only creates new sessions:

```bash
bun run index.ts
```

### Cleanup

Archive agents and delete sessions/environments:

```bash
export $(cat .env | xargs) && bun -e '
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
const [agents, envs, sessions] = await Promise.all([
  client.beta.agents.list(),
  client.beta.environments.list(),
  client.beta.sessions.list(),
]);

await Promise.allSettled([
  ...sessions.data.map(s => client.beta.sessions.delete(s.id)),
  ...envs.data.map(e => client.beta.environments.delete(e.id)),
  ...agents.data.map(a => client.beta.agents.archive(a.id)),
]);
console.log("Cleaned up.");
'
```

## Beta Headers & Compatibility

### Standard Managed Agents

All Managed Agents requests require the `managed-agents-2026-04-01` beta header:

```typescript
await client.beta.agents.create({...}); // SDK sets header automatically
```

### Research Preview: Outcomes (user.define_outcome)

The Outcomes feature is in **Research Preview** and requires:
1. **Request access** at https://claude.com/form/claude-managed-agents
2. **Two headers** during `events.send()`:
   - `managed-agents-2026-04-01` (base Managed Agents)
   - `managed-agents-2026-04-01-research-preview` (research preview)

**Example:**
```typescript
await client.beta.sessions.events.send(
  sessionId,
  { events: [{ type: "user.define_outcome", description, rubric, max_iterations }] },
  {
    headers: {
      "anthropic-beta": "managed-agents-2026-04-01,managed-agents-2026-04-01-research-preview",
    },
  },
);
```

Without research preview access, the SDK's built-in error handling gracefully falls back to `user.message`.

### File Retrieval (Files API)

Downloading files scoped to a session requires:
```typescript
const files = await client.beta.files.list(
  { scope_id: sessionId },
  {
    headers: {
      "anthropic-beta": "files-api-2025-04-14,managed-agents-2026-04-01,managed-agents-2026-04-01-research-preview",
    },
  },
);
```

Without the research preview header, `scope_id` is not recognized.

## How It Works

1. **Agent creation** — LLM + tools configured once
2. **Environment provisioning** — cloud sandbox spun up
3. **Session creation** — agent + environment linked for a new task
4. **Event streaming** — connect to `/v1/sessions/{id}/events/stream` (SSE)
5. **Send task** — `user.message` or `user.define_outcome`
6. **Monitor** — listen to `agent.*`, `session.*`, `span.*` events
7. **Retrieval** — download files from `/mnt/session/outputs/` once `session.status_idle`
8. **Outcome eval** — if using `user.define_outcome`, check `span.outcome_evaluation_end.result`

## Session Flow

```
Session created → Stream opens → Task sent → Agent iterates → Files written
                                                    ↓
                                          (if user.define_outcome)
                                              Grader evaluates
                                           against rubric → result
                                                    ↓
                                          session.status_idle
                                                    ↓
                                          Download files
                                                    ↓
                                          Session complete
```

## Example: Define Outcome

```typescript
const rubric = `
# Code Quality Rubric

## Correctness
- Output is mathematically correct
- File is created in /mnt/session/outputs/

## Code Quality
- Code is clean and readable
- Uses functions appropriately
`;

await client.beta.sessions.events.send(
  session.id,
  {
    events: [{
      type: "user.define_outcome",
      description: "Generate Fibonacci numbers and save to file",
      rubric: { type: "text", content: rubric },
      max_iterations: 3,
    }],
  },
  {
    headers: {
      "anthropic-beta": "managed-agents-2026-04-01,managed-agents-2026-04-01-research-preview",
    },
  },
);

// Listen for outcome evaluation events
for await (const event of stream) {
  if (event.type === "span.outcome_evaluation_end") {
    console.log(`Outcome result: ${event.result}`);
    // result: "satisfied" | "needs_revision" | "max_iterations_reached" | "failed" | "interrupted"
  }
}
```

## Project Files

| File | Purpose |
|---|---|
| `index.ts` | Main entry point — creates/reuses agent + env, runs sessions |
| `.state.json` | Persisted agent & environment IDs (auto-created) |
| `.env` | Your API key (must create manually) |
| `outputs/<sessionId>/` | Deliverables from each session |

## Notes

- **Agent persistence** — once created, the agent is reusable for any number of sessions
- **Environment reuse** — same sandbox environment works for all sessions
- **Parallel sessions** — sessions are independent; run multiple in parallel via `Promise.all()`
- **No data leakage** — each session's files isolated in `/mnt/session/outputs/` within the sandbox
- **Outcome evaluation is optional** — fallback to `user.message` if research preview access not available

## References

- [Managed Agents API Docs](https://platform.claude.com/docs/en/managed-agents/overview)
- [Events & Streaming](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)
- [Define Outcomes (Research Preview)](https://platform.claude.com/docs/en/managed-agents/define-outcomes)
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript)
