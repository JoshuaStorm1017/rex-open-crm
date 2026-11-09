# rex-dev-pipeline

Explicit state machine for one development task. It sits beside `rex-ai-gateway` and does not change the CRM plan/confirm runtime.

The pilot is simulated. It does not merge, deploy, open a pull request, start a schedule, or call Cursor. Live effects stay off unless a future operator turns them on, and even then the merge call is not wired.

Fictional data only. The demo repository is `https://github.com/example/rex-demo`.

## How this fits plan / confirm

The gateway already separates a proposal from a write:

| Gateway today | This pilot |
| --- | --- |
| `POST /v1/ai/plan` stores a preview and does not write | Intake pins a task contract and context. Nothing is merged |
| Confirm requires the stored proposal id | Guarded merge requires an owner approval row bound to the commit SHA |
| A stale `If-Match` etag refuses the write | A test, review, or approval for a different SHA is refused |
| `Idempotency-Key` replays the stored response | An event id and an outbox delivery replay instead of running twice |
| SQLite keeps previews, audit, and undo across a restart | SQLite keeps state versions, attempts, approvals, the event ledger, and the effect outbox |
| The mock CRM is the default. Twenty is opt-in | The scripted adapter is the default. The Cursor client is not selected by the CLI |

A CRM write still waits for a stored preview. This package does not call `/v1/ai/plan` or `/v1/ai/act`.

## Graph

Routine edges are code. The model is only the worker at three nodes: `implementation`, `independent_review`, and `bounded_repair`. The model does not choose the next state. A typed artifact does, and the machine checks it.

```text
authorized_intake -> pinned_contract -> implementation -> trusted_tests
  -> independent_review -> human_merge_approval -> guarded_merge -> verified
independent_review -> bounded_repair -> implementation
trusted_tests -> blocked            (compile or tests failed)
independent_review -> failed        (repair cap)
pinned_contract -> reconciling -> pinned_contract
                                  (unknown launch, then confirmed absent)
guarded_merge -> reconciling -> guarded_merge
human_merge_approval -> trusted_tests
                                  (commit advanced; no other state)
any active -> paused | reconciling | failed
paused -> the state that was paused, only after an explicit resume
```

`paused` is resumable and performs no adapter call. An in-flight result that returns after pause is held as unknown and read back on resume; it does not move the run. `reconciling` is resumable and only reads. `blocked` is resumable for a missing or expired approval and for an invalidated context. A test failure blocks review and merge; this pilot does not auto-repair a red test. `failed` and `verified` are terminal.

A completion is applied only when its kind matches the open effect and the current state. A review artifact cannot stand in for test evidence, and a merge artifact cannot stand in for a review. `advanceCommit` is only `human_merge_approval -> trusted_tests`. `transition` throws if the state pair is not in the edge list or the pause, fail, block, or resume overlays.

`npm run graph` prints the edge list.

## Research, kept distinct

- Andrej Karpathy's verified LLM Wiki pattern (gist `442a6bf555914893e9891c11519de94f`, April 2026) compiles a persistent interlinked knowledge base so later questions do not re-derive the synthesis. That is a wiki, not an executable decision graph. No verified executable decision-graph proposal from him was found. His verifiability note is a different claim: tasks with a resettable, checkable result are the ones that can be improved against an automated signal. That is why a passing test command is evidence here, and a string `YES` is not.
- Anthropic's "Building effective agents" distinguishes workflows (code chooses the path) from agents (the model chooses the path). This pilot is a workflow. Model work is confined to the three nodes above.
- The Vercel Workflow SDK (`"use workflow"` / `"use step"`) is a durable-execution runtime for applications already on that SDK. This repository's Rex glue is a small Node process with SQLite. Adopting the SDK would be a framework rewrite, so the durability mechanism is the ledger instead.
- Cursor's Cloud Agents API v1 is a public beta (`https://cursor.com/docs/cloud-agent/api/overview`). Webhooks are documented as coming soon on v1; the legacy v0 API still has them. This client does not register a webhook and does not call v0. Create is `POST /v1/agents` and can send a client `agentId`; a repeat returns `409 agent_id_conflict` rather than a replayed body. Follow-up is `POST /v1/agents/{id}/runs` and has no idempotency key. The docs say a retry is a new prompt. Status is read with `GET /v1/agents/{id}` and `GET /v1/agents/{id}/runs`. List items do not echo the prompt, so a follow-up reconcile that sees more than one new run stays uncertain.

## What is stored

`node:sqlite`, same built-in the gateway uses. File mode `0600` when the path is not `:memory:`.

- `runs` and `state_versions` for the current state and every version
- `events` for intake, completions, approvals, and transitions
- `effects` and `outbox` for intended, unknown, present, absent, applied, and suppressed work
- `artifacts`, `attempts`, and `approvals`
- `contexts` with a content hash, source list, and invalidation time
- `inbox` for a completion that arrives before its effect row

A context with the same hash is reused and marked `contextReused`. An invalidated row is not reused. A new pin of the same sources creates the next version.

Restart loads the same file. An effect left `intended` or `unknown` is reconciled before another send. Duplicate event ids return the first result and do not bump the version. A completion that lands before the launch ack is applied once.

## Caps

Defaults, and also the maximums this pilot will accept:

| Cap | Value |
| --- | --- |
| Writers | 1 |
| Repair attempts | 2 |
| Agent runs | 7 |
| Active minutes | 90 |

These are engineering caps. They are not a dollar budget and they do not measure token spend. Active time excludes pause, block, terminal states, and the wait at `human_merge_approval`. A missing usage envelope (`{ "acknowledged": true }`) creates the run already `paused`. Nothing is scheduled and nothing resumes itself.

## Adapters

| Effect | This pilot |
| --- | --- |
| Writer launch and repair follow-up | Scripted adapter. The disabled Cursor client can build the documented v1 requests |
| Independent review | A second scripted launch, not a follow-up to the writer |
| Tests | Scripted structured evidence: command, exit code, pass count, fail count, digest |
| Merge | Simulated ledger row when live effects are off and the approval matches. No git push and no Cursor merge call |

`CursorCloudAdapter` is constructed only by its unit test, with an injected `fetch`. The CLI never reads `CURSOR_API_KEY` or any local session. The client refuses repositories outside `https://github.com/example/<name>`, refuses to run when `enabled` is false, and performs one HTTP call per method. A thrown fetch or a 5xx becomes `unknown` and is not retried inside the client.

Turning `liveEffectsEnabled` on does not verify the run. The merge effect is stored as `suppressed` with reason `live_merge_not_wired`. There is no documented merge endpoint used here, and none was invented.

## Commands

From `rex-dev-pipeline`. This package is not in the Yarn workspace. The Twenty app in this repo requires Node 24.5; this package runs on Node 22 or newer because it does not start the front. The run recorded below used Node v22.23.4, which is the Node installed in this environment.

```bash
npm install
npm test
npm run typecheck
npm run demo
npm run graph
npx tsx src/cli.ts demo --scenario test-failure
```

Scenarios: `happy`, `test-failure`, `review-repair`, `paused`, `uncertain-launch`, `cap`.

Recorded on Node v22.23.4:

- `npm test` — 30 passed, 3 files
- `npm run typecheck` — passed
- `npx --yes oxlint@1.51.0 src` — 0 warnings and 0 errors on 17 files

This package is outside the Nx lint projects, so that oxlint command is the lint run.

## Limitations

- One process. Two overlapping `pump` calls are not supported.
- The library trusts the caller to pass the owner id. It enforces that the reviewer artifact is not the writer and that the approval approver is the configured owner. It is not a multi-user auth system.
- Test failure stops the run. A new run is the resume path.
- Follow-up reconciliation on the real API can stay uncertain when several runs appear after the send, because the list does not include the prompt.
- No savings number is claimed. The caps are not a cost control.
- No schedule, webhook receiver, or automatic resume.

## Remaining steps before any live operation

1. Keep the default off. Do not set `liveEffectsEnabled` in a deployed process until the steps below exist.
2. Supply a Cursor API key only at runtime, from outside the repository. Do not add it to `.env` in git.
3. Decide a real repository allow-list. The client currently refuses anything except `github.com/example`.
4. Replace the scripted test adapter with the repo's real `tsc` / `vitest` invocation, and store the exit code and digest from that process.
5. Add a merge mechanism that already exists for this repo's forge, still behind the SHA-bound approval. Do not invent an undocumented Cursor endpoint.
6. Re-read the v1 Cloud Agents docs before enabling the client. The API is a public beta and v1 webhooks were not available when this pilot was written.
