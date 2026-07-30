# Peer Agents and Shared Memory

Status: Design (brainstormed 2026-06-07, not yet planned)

Scope: how ClearClaw lets multiple related agents collaborate, and the shared memory layer that makes them cohere, without introducing an orchestrator agent. This is the "why" story. The implementation plan belongs in docs/plans/.

## Problem

The ask: enable multiple agents for related work without building an orchestrator that plans and spawns subordinate agents (the OpenClaw "PI" model). Conceptual modeling first, not implementation.

The concrete pain driving it: work that spans contexts (two repos, or a project and ClearClaw itself) forces manual handoffs. Today that means asking one agent "give me a prompt I can send to service A to resolve the latency we saw," then copy-pasting it into another chat. It works, but it is manual and one-directional. The goal: make handoffs less manual, allow back-and-forth, keep the human in the loop guiding each agent separately, and let a thread grow into a full workstream. These are peer agents working on related-but-separate things, not a main agent with subagents.

## Guiding principle

ClearClaw is a switchboard, never a boss. It relays plumbing, never cognition. Decision-making lives with the human (above the relay) or inside the engine (below it), never in the relay itself. The existing transparent relay carries messages between a human and an agent; this design extends the same relay to carry messages between two agents, with the human able to watch the wire and step in anywhere. The moment a model sits between the human and a worker deciding routing, we have rebuilt the orchestrator we set out to avoid.

## Part 1: The peer-agent model

An "agent" today is one shared persona (the instance-global identity) pointed at a working directory. The persona is the same everywhere; what differs per agent is the cwd it sits in. So peers are the same mind in different rooms, and an agent's expertise is emergent from its directory, not declared. The directory is the card.

Decisions, each against the road not taken:

- Peers are workspaces, each bound to its own chat. Rejected multi-bot: multiple identities are already provided by workspaces (same bot, different cwd, different face). A separate bot only buys co-presence and separate addressability inside one chat, which is not the need here. Peers live in separate chats and are supervised separately.

- Same mind, separate working state. The persona, user profile, and shared instructions are instance-global; differentiation is the cwd and its own CLAUDE.md and skills. Rejected per-workspace identity and distinct specialist personas: the handoffs we care about are context handoffs (repo A to repo B to ClearClaw), not personality handoffs.

- A handoff is a tool call. It rides the existing permission relay (Allow / Deny / Deny+Note) and the existing permission mode. Rejected a separate approval model: nothing new to configure. Allowlist the tool for frictionless sending, or leave it in default to see each send.

- Explicit, symmetric texting with natural termination. A sends to a peer deliberately via the tool; when the peer is done it chooses to message back, or not. Both directions use the same peer-to-peer send. Because replies are deliberate, a thread ends on its own when a side has nothing more to add. Rejected RPC or synchronous handoff (A blocking on B recreates the subagent shape) and a forced loop cap (unnecessary once replies are deliberate).

- Spin-out is the core interaction. Mid-work, an agent notices a related-but-separate strand and proposes splitting it. The human approves, and it either routes to an existing peer or spawns a new one. The new agent is seeded with a distilled brief: the goal plus the few specifics it needs, not a context dump. This is the original "give me a prompt to send," now written by the agent, approved by the human, and delivered.

- Spawn fresh by default; reuse only for a true continuation. "Busy" is not turn-activity (a message processing this second); it is context dedication. A session committed to one task is occupied even while idle, and dropping an unrelated strand into it causes context contamination. So a separate task gets its own agent. The human is the focus oracle (you know what each session holds); the system tracks no status, and default-fresh means a wrong reuse guess can never contaminate.

- Same-repo parallelism uses git worktrees. Two agents on one cwd collide on files, the git working tree, and the session store (keyed by cwd). Auto-spawning a worktree per parallel strand isolates them. Worktrees already exist in the onboarding flow.

- Lifespan and isolation are independent dials, both chosen by the human: persistent or ephemeral, main checkout or worktree. A long-lived worktree agent for a series of small tasks is a valid quadrant, not an anomaly.

- Spawned peers live in human-provisioned spawn surfaces. Bots cannot create Telegram chats, so the human creates a forum-enabled group once and registers it as a spawn surface bound to a scope (specific workspaces, or default catch-all); the bot then mints a topic per spawned peer inside it. The registration is a manually curated routing rule — the same trust model as workspace creation: humans provision surfaces, the bot populates them. The surface registry and resolution logic are platform-neutral; what an "anchor" means lives inside each Channel implementation (Telegram: forum group + topics; Slack: no container needed — bots create channels directly, so the anchor degenerates to a naming convention). Rejected a single global "workers" forum: the binding model subsumes it (one default surface) while allowing per-repo or per-concern forums.

- Do not model "Task." Three layers already cover context: the session is working context (persisted by the engine, per cwd), git is the durable record, and the channel transcript is the human-readable log. A first-class Task entity would duplicate these and rot.

## Part 2: Shared memory

Memory is the layer the Part 1 context layers miss: durable knowledge that survives sessions, plus lightweight awareness of what other agents are doing. It does two jobs, it makes the peers one mind, and it gives the switchboard insight into what is happening across agents.

Model it as one memory system with two time horizons, the way human memory works.

- Short-term memory (STM): recent activity. Each turn, ClearClaw appends a short "what just happened here" entry for that workspace. It is fresh, it decays, and reading it across workspaces IS the cross-agent awareness, the switchboard insight, with no separate roster mechanism. STM also doubles as the staging that feeds long-term memory.

- Long-term memory (LTM): the durable layers we already have. LTM is not one new file; it is Instructions (behavioral rules), Memory (facts and decisions), and the Knowledge Base (topical depth). Keep each bounded, small enough to inject whole, so there is no index and no retrieval step. The cap forces curation, which is what makes memory useful.

The mechanics, all orchestrator-driven, no engine hooks (ClearClaw owns the turn loop and runs these itself):

- Capture (per turn). After the reply has streamed, ClearClaw runs an async, out-of-band step that appends a recent-activity entry to STM. Pure side effect: it never returns content into the conversation (that would risk an instruction-interpretation loop, the OpenClaw issue #987 failure), never blocks the turn, and fails safe (a broken write never breaks a turn). The transcript is the raw source underneath; STM is the light gist on top.

- Consolidate (one pass, on demand). Triggered when a target crosses its size cap (primary, content-driven, self-tuning), on a daily floor (backstop), or on demand. The pass promotes durable STM into its right home, routing as the framework already prescribes: a fact or decision to Memory, a researched topic to the Knowledge Base, a behavioral rule to Instructions. Promotion is gated by the distiller's judgment plus the size cap, promote only what earns a slot, dedupe, stay bounded; an optional recurrence signal (did it recur across sessions) can sharpen it. Memory and KB write freely; Instructions are proposed, not silently self-edited, since they change behavior every turn and are the prime poisoning target. The pass then ages out stale STM and emits a narrated diary, a short human-readable account of what it reflected on, learned, and changed, so it is transparent and you can veto. Higher-level reflection (inferring new insights, not just promoting facts) is an optional add-on folded into this same pass later, not a separate phase.

- Read (per turn). Inject recent STM (awareness) plus LTM (durable knowledge) through the existing prompt assembly. The agent never has to choose to look.

Scope, settled: ClearClaw builds exactly one thing, the cross-cutting shared brain that spans every workspace and session. Per-project memory is not built; it lives in the repo (CLAUDE.md, docs) and in Claude Code's free native auto-memory. The auto-capture loop writes only to the shared brain, so a user's repo is never silently churned.

## Cross-system validation

The shape matches the canonical prior art, so we reuse patterns rather than invent:

- Hermes (Nous Research): a bounded markdown brain, distillation (save the takeaway, not the source), per-turn capture plus periodic consolidation, and a brain-versus-library split. Same shape as ours.
- Generative Agents (Stanford): the memory-stream then reflection pattern, with importance scoring. We borrow the selectivity (promote only durable, high-value items) and the reflection recipe; we skip the retrieval scoring because the bounded brain is injected whole.
- MemGPT / Letta: tiered core/recall/archival, which maps onto our LTM / transcript-STM / KB. Letta itself warns self-editing is unreliable ("if the model fails to save, it is gone"), exactly the failure observed in the live store, and why capture is a deterministic orchestrator step, not left to the model.
- OpenClaw / Anthropic / OpenAI "dreaming": background consolidation with gated promotion and a human-readable dream diary. We take two things, the gated-promotion principle and the narrated diary, and drop the rest (the scoring engine is retrieval-derived, the sleep-cycle phases are just names for capture/promote, and the module is coupled to the OpenClaw runtime, so we reimplement the pattern, not the code).

Mem0, Honcho, claude-mem, and ClawMem are drop-in providers, but all carry SQLite or vector retrieval to power search, which the bounded brain opts out of. Reuse the pattern, not a dependency. Both Hermes and OpenClaw also flag memory poisoning, which feeds open question 1.

## Rejected roads

- An orchestrator or PI agent that plans and spawns workers (the OpenClaw model).
- Multi-bot as the path to multiplicity.
- Per-workspace identities or distinct specialist personas.
- RPC or synchronous handoff (the sub-agent shape).
- A separate permission model for handoffs.
- A status-tracking subsystem to know which agent is "busy."
- Modeling "Task" as a first-class entity.
- A per-workspace memory tier (lives in the repo + native auto-memory instead).
- Index-plus-pull or vector RAG for memory read (deferred, not permanently closed).
- Engine hooks for memory (ClearClaw owns the turn loop and runs capture/consolidate itself).
- A weighted scoring engine for promotion (retrieval-derived; unnecessary for a bounded, inject-whole brain).
- Sleep-cycle phase names (Light/Deep/REM) and other borrowed dressing; they are just labels for capture and promote.
- Silently self-editing Instructions (proposed in the diary instead, since they change behavior every turn).
- Fixed-time or idle-threshold consolidation triggers (magic numbers); the brain-size cap is the primary, content-driven trigger.

## Open questions (parked)

1. Memory poisoning. The shared brain is injected every turn, including group and multi-user workspaces, so a bad entry is persistent policy corruption. Leaning mitigation: Instructions are proposed-not-silent, the narrated diary is the human review surface, and group-participant content should not auto-write to the shared brain. Still to settle: exactly what is injected in group chats, and whether writes need scanning.

2. Tuning constants. The triggers are settled (size cap primary, daily floor backstop, on-demand); the values are not, the bounded-brain cap and the daily cadence are the two numbers to pick.

3. Optional add-ons to the consolidation pass: higher-level reflection (inferring new insights, not just promoting facts) and a self-improving skill-writing loop (Hermes-style). Both out of scope for the first build.

## Build sequence

This is direction, not a plan. The implementation plan belongs in docs/plans/.

- Phase 1: peer messaging (the handoff tool), spin-out, and auto-spawned worktree agents. This solves the stated pain and is the smaller build.
- Phase 2: shared memory, STM capture (per-turn, orchestrator-side), consolidation (size-cap / daily / on-demand) that promotes into Instructions / Memory / KB with a narrated diary, and injection of recent STM + LTM each turn. The coherence layer that makes the peers one mind and gives the switchboard awareness.
