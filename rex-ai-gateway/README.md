# rex-ai-gateway

Thin allowlist in front of Twenty. An LLM (or the AI command bar) calls this process. The gateway turns the call into an allowlisted tool, then asks a `TwentyCrmClient` to read or write the record. It never opens Twenty's database.

This package is Rex glue beside Twenty. It is not part of the Yarn workspace and it does not build the Twenty monorepo. Twenty stays under its own license (AGPL-3.0). The gateway is added in this same AGPL-3.0 tree.

Fictional data only. The samples below use `ws_demo` and `*.example` addresses.

## Run

Requires Node.js 22 or newer. The Twenty web app in this repo requires Node.js 24.5. From this directory:

```bash
npm install
npm test
npm start
```

`npm start` listens on `http://127.0.0.1:8787` and uses an in-memory mock. Records disappear when the process stops. Nothing is written to Twenty until you opt in.

## Demo: intent to a Person

With the mock server running, preview first. The plan does not write. Copy `proposal.id` into the confirm call. `POST /v1/ai/act` runs that stored preview and ignores any tools in the confirm body.

```bash
curl -s -X POST http://127.0.0.1:8787/v1/ai/plan \
  -H 'content-type: application/json' \
  -d '{
    "workspaceId": "ws_demo",
    "intent": "create person Ada Lovelace email ada@analytical.example"
  }'
```

```bash
curl -s -X POST http://127.0.0.1:8787/v1/ai/act \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-ada-1' \
  -d '{
    "workspaceId": "ws_demo",
    "confirmed": true,
    "proposalId": "proposal_…"
  }'
```

A success body looks like:

```json
{
  "ok": true,
  "workspaceId": "ws_demo",
  "results": [
    {
      "tool": "create_person",
      "status": "created",
      "record": {
        "id": "person_…",
        "objectName": "person",
        "workspaceId": "ws_demo",
        "properties": {
          "firstName": "Ada",
          "lastName": "Lovelace",
          "email": "ada@analytical.example"
        }
      }
    }
  ]
}
```

Refusals are HTTP 400 with `refused: true` and a `reason`:

| reason | when |
| --- | --- |
| `unknown_tool` | name is not on the allowlist |
| `missing_required_fields` | a required arg is blank or absent |
| `cross_workspace` | an arg names a workspace other than `workspaceId`, or the request workspace is not the one this process is bound to |
| `unmapped_intent` | the intent is not one of the sentences the planner knows |
| `unsafe_intent` | the planner refuses a hard delete, export, or credential request |
| `ambiguous_intent` | an update does not name exactly one record, or it says "this record" when none is open |
| `forbidden` | the signed-in member's role cannot perform the tool (HTTP 403) |
| `not_found` | the named record does not exist |
| `precondition_failed` | `ifMatch` is not the current etag (HTTP 412) |
| `unauthorized` | bearer token is missing or wrong (HTTP 401). Applies to plan, act, tools, and audit |
| `idempotency_conflict` | the idempotency key was reused with a different body (HTTP 409) |
| `confirmation_required` | act did not confirm a live preview id, so nothing was written |
| `invalid_request` | the JSON body is the wrong shape |

`workspaceId` is a gateway token such as `ws_demo`, not Twenty's internal workspace uuid.

## Allowlist

Only these tools run. Anything else is refused before the client is called.

| tool | required | optional |
| --- | --- | --- |
| `create_person` | `firstName`, `lastName` | `email`, `jobTitle`, `phone` (`+1 4155550134`), `linkedin`, `companyId` (`$n` may point at an earlier create or update) |
| `create_company` | `name` | `domain` or `website`, `linkedin`, `address`, `city` |
| `create_opportunity` | `name` | `amount`, `currencyCode` (default `USD` when amount is set), `stage` (`NEW`, `SCREENING`, `MEETING`, `PROPOSAL`, or `CUSTOMER`; default `NEW`), `companyId`, `pointOfContactId`, `closeDate` |
| `create_note` | `body`, `targetObject` | `title`, `targetId` or `targetQuery` (`$n` may point at an earlier create or update) |
| `search_records` | `object` (`person`, `company`, or `opportunity`), `query` | `limit` (1–20, default 10) |
| `search_notes` | `query` | `limit`. Matches note title and `bodyV2.markdown`. Read-only, still preview then confirm |
| `search_tasks` | `query` | `limit`. Matches task title and `bodyV2.markdown`. Read-only, still preview then confirm |
| `search_activities` | `query` | `limit`. Matches `linkedRecordCachedName`. Twenty does not full-text index activity payloads |
| `update_record` | `object`, `field`, `value`, and either `id` or `query` | `ifMatch` (filled from the current record when the preview can load it) |
| `update_matching_records` | `object`, `query`, `field`, `value` | Expands to one `update_record` per match, at most 8. A wider match is refused. The preview lists every target and field |
| `archive_record` | `object`, and either `id` or `query` | `ifMatch` (filled from the current record). Soft-delete only |

`GET /v1/ai/tools` returns the same allowlist as JSON Schema for an external agent. It uses the same bearer check as act and audit. `ifMatch` is the record etag (`v1` on the mock, `updatedAt` from Twenty). A mismatch is HTTP 412 and does not write. Twenty's REST API ignores an `If-Match` header, so the HTTP client sends the etag as `updatedAt[eq]` on an update-many filter. Archive uses the same filter on soft-delete many (`DELETE` with `soft_delete=true`). Zero matched rows means nothing was written. Several field writes on one record in one preview keep the first etag and mark the later writes `chained`. Confirm refreshes If-Match from the etag the previous write in that act just returned. A literal `chained` or `created` token is not a live etag: the HTTP client rejects it before any Twenty write. A write chained after an archive in the same preview is refused, and the archive is restored.

Writable fields: person `firstName`, `lastName`, `email`, `jobTitle`, `phone`, `linkedin`; company `name`, `domain`, `website` (the same link as `domain`), `linkedin`, `address` (street), `city`, `accountOwner` (also accepted as `owner`); opportunity `name`, `stage`, `amount`, `closeDate`, `owner`. `stage` must be one of the Twenty opportunity values above. `closeDate` is `YYYY-MM-DD`. `linkedin` is a `linkedin.com` URL and is stored as `https`. `owner` and `accountOwner` are `me` (the signed-in member) or a workspace member id. `phone` is a calling code the gateway knows (`+1`, `+33`, `+44`, `+49`, `+61`) plus the national number.

`archive_record` soft-deletes a person, company, or opportunity (`DELETE` with `soft_delete=true`, or the GraphQL `delete` mutation). It does not destroy the row. Undo of an archive calls Twenty's restore route. Hard delete stays refused.

Search text is allowlisted before it is placed in a REST filter: 1–80 letters, numbers, spaces, or `. @ ' + -`. Quotes, brackets, commas, and LIKE wildcards are rejected, and the value is JSON-quoted rather than concatenated. GraphQL search already uses variables.

`amount` is major units. The HTTP client converts it to Twenty `amountMicros` (× 1,000,000).

A non-empty `tools` array wins over `intent`. One intent maps to one tool. Batches use `tools`.

Intent sentences, in this order:

```text
create person <first> <last> [email <email>] [job <title>]
create company <name> [domain <domain>]
create opportunity <name> [amount <number>] [stage <stage>] [company <companyId>]
```

## Authentication

Two callers, and they do not share a credential.

**Signed-in member (the command bar).** The browser calls the gateway with `credentials: 'include'`. The session cookie (`twenty-session` or `__Host-twenty-session`) is the member's own Twenty session. The gateway forwards that cookie and the browser `Origin` to Twenty's metadata `currentUser` / `currentWorkspace` query. Twenty accepts the cookie only from an origin it already allows, which is how its CSRF check is satisfied. The actor stored in the audit log is the email Twenty returns. `X-Rex-Actor` is ignored. Plan, act, tools, and audit are limited to that member: a preview or idempotency key from someone else is not visible, and audit rows are too. CRM reads and writes use the same session, so Twenty applies that member's permissions. The gateway does not have a workspace API key.

The cookie is host-only. The command bar calls `http://localhost:8787` when the page is on `localhost`, and `http://127.0.0.1:8787` when the page is on `127.0.0.1`, so the cookie is actually sent. `REX_AI_GATEWAY_TOKEN` is never read from `window._env_` and is not part of the client bundle.

**Service bearer (another server or an external agent).** `Authorization: Bearer <REX_AI_GATEWAY_TOKEN>` proves the caller may use the gateway. `X-Twenty-Authorization: Bearer <Twenty access token or API key>` is the credential Twenty will see. The gateway resolves identity by calling Twenty with that token and then uses it for the writes. A session token (`sess_…`) is rejected on this header; Twenty only accepts those from the cookie. This path does not fall back to a process-wide API key, and it does not accept `X-Rex-Member`.

`TWENTY_API_KEY` is ignored. If it is set, the process logs that and continues.

Loopback with no `REX_AI_GATEWAY_TOKEN` still requires one of the two credentials above when `TWENTY_API_URL` is set. Without `TWENTY_API_URL`, the in-memory mock accepts `X-Rex-Member: <email>` or any allowlisted-origin session cookie and never calls Twenty. That header is not an identity source once a real Twenty URL is configured.

A non-loopback bind still refuses to start unless `REX_AI_GATEWAY_TOKEN` is set. Member browsers do not need to know that token.

## Twenty HTTP client

Leave `TWENTY_API_URL` unset to keep the mock.

To forward writes as the signed-in member, copy `.env.example` to `.env` and set the Twenty origin:

```bash
npm run start:twenty
```

| variable | purpose |
| --- | --- |
| `TWENTY_API_URL` | Twenty origin, for example `http://localhost:3000` |
| `TWENTY_WORKSPACE_ID` | When set, every act request must use this gateway `workspaceId` (`ws_*`, not Twenty's uuid) |
| `TWENTY_API_STYLE` | `rest` (default) or `graphql` |
| `REX_AI_GATEWAY_HOST` | Default `localhost`, so the browser session cookie is sent. Use the same host name as the page |
| `REX_AI_GATEWAY_PORT` | Default `8787` |
| `REX_AI_GATEWAY_TOKEN` | Service-to-service credential. Required to listen beyond loopback. Not a substitute for the member token, and not sent to the browser |
| `REX_AI_STATE_PATH` | SQLite file for previews, idempotency, and audit. Default `data/gateway-state.sqlite` in the gateway directory. Survives a restart |
| `REX_AI_CORS_ORIGINS` | Comma-separated browser origins. Unset allows `http://localhost:3001`, `http://127.0.0.1:3001`, `http://localhost:3000`, and `http://127.0.0.1:3000`. Credentialed responses set `Access-Control-Allow-Credentials` only for an allowlisted origin |
| `REX_AI_PROVIDER` | `mock` (default) or `openai`. Tests and `npm start` stay on `mock` |
| `REX_AI_BASE_URL` | Public OpenAI-compatible **https** origin, required when the provider is `openai`. Cleartext `http` to a non-loopback host is refused so the API key is not sent in cleartext. Private, loopback, and metadata hosts are refused. DNS is pinned before the key is sent, and redirects are not followed |
| `REX_AI_API_KEY` | Provider key. Read from the environment only. Never commit it, and never put it in `window._env_` |
| `REX_AI_MODEL` | Model name, required when the provider is `openai` |

The mock provider is deterministic and makes no network call. It is what `npm start` and the tests use.

## Run with a real model

`openai` is any Chat Completions API. The key stays in the environment. The gateway asks the model for tool calls from the allowlisted catalog (`additionalProperties: false`). A free-form JSON plan in the message content is refused and is not executed. Each tool call is checked again on the server against the allowlist and the argument schema, then shown as a preview. Confirm runs the stored preview. It does not call the model a second time and it does not trust a tools array on the act body.

```bash
cp .env.example .env
# Set the key in .env. Do not commit that file.
# REX_AI_PROVIDER=openai
# REX_AI_BASE_URL=https://api.openai.com/v1
# REX_AI_API_KEY=...
# REX_AI_MODEL=gpt-4o-mini
# TWENTY_API_URL=http://localhost:3000
npm run start:twenty
```

Leave `REX_AI_PROVIDER` unset, or set it to `mock`, to keep the deterministic planner. A public `TWENTY_API_URL` hostname is resolved and the connection is pinned to that address so a later DNS answer cannot move the member credential onto a private host. Loopback origins are not pinned.

`GET /v1/ai/tools` returns only the tools the signed-in member can perform. Create and update are separate gates. Twenty's object permission has no create flag, so the HTTP reader fills `canCreate` from `canUpdateObjectRecords`. A caller that supplies both can refuse creates while still allowing updates. Search and update also require read. Archive requires read and soft-delete, not update. Undoing an archive uses that same soft-delete gate. Notes require create on `note` and read on the target. Field permissions come from `objectPermissions.restrictedFields`, matched to Twenty field names (`emails` for `email`, `domainName` for `domain` and `website`, and so on). A field with `canUpdate: false` or `canRead: false` is left out of the update tool and of the create tool, and refused on plan and on confirm. Creating a person, company, or opportunity must not set a restricted field. Opportunity create always writes `stage`, so a locked stage refuses the create. If the field list or `restrictedFields` cannot be read, every field write and every create is refused. Object permissions that omit field data, which is how the in-memory tests model a role, still allow the allowlisted fields. Note, task, and timeline-activity search appear only when that object can be read. Plan and act refuse a hidden tool with `forbidden` even if a model asks for it. When object permissions cannot be read, the catalog is empty and nothing is proposed.

## Plan, then confirm

`POST /v1/ai/plan` interprets plain English and returns a proposal. It does not write. The headline is built from the validated tools, not from the model's own summary. Send `Accept: text/event-stream` to receive `partial` events while the model is still emitting tool calls, then one `proposal` event. A partial has no proposal id and cannot be confirmed. The command bar shows those lines, then the settled preview, and only after Confirm posts `proposal.id` to `POST /v1/ai/act` with `confirmed: true`. Act runs the stored tools. A tools array on act, or `confirmed` without a live preview id, is `confirmation_required` and does not write. Cancel sends nothing. Without the event-stream header, plan still returns one JSON body.

```bash
curl -s -X POST http://127.0.0.1:8787/v1/ai/plan \
  -H 'content-type: application/json' \
  -d '{
    "workspaceId": "ws_demo",
    "intent": "add Acme Corp as a company and a $50k deal for Jane Doe"
  }'
```

`$50k` is 50000 major units. The opportunity links to the company and person created in the same request (`companyId: "$0"`, `pointOfContactId: "$1"`).

Other mock sentences:

```text
find companies named Acme
update company <id> set domain to acme.example
update company named Acme set domain to acme.example
update person named Ada Lovelace set email to ada@analytical.example and jobTitle to Analyst
update person named Ada Lovelace set jobTitle to Analyst and update company named Acme set city to Lisbon
update this deal's stage to Proposal
update this person's email to ada@analytical.example and jobTitle to Analyst
update all companies named Acme set city to Lisbon
find notes about the pilot
find tasks containing brief
find activities linked to Acme
add a note: Called the buyer
```

The "this" sentences need `context` for the open record. "this deal" means the open opportunity. Two fields on one named record are two writes. The second If-Match is chained to the first.

A named update that matches zero records is `not_found`. More than one person, company, or opportunity is a preview with one radio per match. The name stays on the radio. The detail line shows email, domain, and city when those fields exist, or stage and amount for an opportunity. People and companies also get a "create new" choice. Confirm sends `choiceId`. `create_new` creates the person or company, then applies the note or the field change. Opportunities can be chosen but not created from that picker. Nothing is written until one choice is confirmed. Hard deletes, exports, and credential requests are `unsafe_intent`. `archive company named Acme` soft-deletes.

A plan can name two ambiguous records. The preview then has one group per name (`choice.groups`). Confirm sends `choices: { "0": "<id>", "1": "<id>" }`. One group still accepts `choiceId`. A missing choice writes nothing. Two field changes that share one ambiguous name are one group, and the chosen record receives every field.

On a record page, and when that record is open in the side panel while the main page is a list, the command bar sends `context: { objectName, recordId }` for the open person, company, or opportunity. The side panel wins when both are present. The mock planner accepts "update this deal's stage to Proposal" and "add a note: …". The model is told to set `recordRef` to `open` and is not given the record id. The gateway loads the open record and substitutes its id before the preview is stored.

Before a real model plans, the gateway also loads a short list of records that the member can already read (up to five recent people, companies, and opportunities). The prompt contains a handle (`p1`, `c1`, `o1`), the label, and the same detail the picker shows. It does not contain the record id. The model may set `recordRef` to that handle. The gateway replaces the handle with the id it loaded. An id the model invents is refused unless the member typed that id and the id is UUID-shaped (a UUID, or a short prefix plus a UUID, such as the mock's `company_<uuid>`). A name query is still allowed when the record is not in the list, and several matches still open the picker.

A successful write returns `undo: { id, summary }` and `undos`, newest first, when the act created records, changed fields, or archived a record. Up to eight reversible acts are kept per member. `POST /v1/ai/undo` with the newest id and `confirmed: true` soft-deletes created records, writes the previous field values back (including clearing a field that was empty), and restores an archived record. If a newer act is saved while that undo is in flight, the undo stops before it overwrites the newer write. Nothing is reversed when the newer act lands first; a reversal that already finished stays, and the rest of the ticket remains after the newest change is undone. An older id is refused until the newer one is undone. The response then includes the next undo, so the command bar can keep going in order. Created notes are compared to their etag first. If the note changed, nothing is deleted and the same undo id stays available for a retry. A conflicting field undo is kept the same way. A later undo that only moves the etag still reverses an older field change when the field still holds the value that act wrote. The command bar leaves the Undo button in place and shows the refusal. The undo is audited as `undo`, and that row's `reverses` is the audit id of the act it reversed. Search-only acts do not change the stack.

A multi-tool act is not a Twenty transaction. If a later tool fails, the gateway deletes the records created earlier in that act and restores updated fields to the value loaded before the write. When a rollback itself fails, the response is `partial_failure` (HTTP 409) and names the records that remain.

`Idempotency-Key` on `POST /v1/ai/act` replays the stored response when the body matches, and returns 409 `idempotency_conflict` when the same key is reused with a different body. Keys are stored per member. `GET /v1/ai/audit` lists that member's rows: who (the identity Twenty returned), what, when, and the result. Failed calls to tools and audit are stored as `tools` and `audit`, not as `act`. Previews, idempotency keys, and the audit log are in the SQLite file from `REX_AI_STATE_PATH`, so a restart does not forget a confirmed write or a live preview. These ideas are adapted from rex-crm-public's bearer API auth, `Idempotency-Key`, and `If-Match` on writes. The member path is the Twenty session, not a shared API key.

## Command bar

In the Twenty web app, Ctrl+Shift+K or ⌘⇧K opens the AI command bar (Ctrl/Cmd+K is already the command menu, and Ctrl/Cmd+J is the log console). The button labelled "AI command" opens it too. The bar calls this gateway on the same host as the page, port `8787`, and workspace `ws_demo`, unless `window._env_` sets `REX_AI_GATEWAY_URL` or `REX_AI_WORKSPACE_ID`. It does not read `REX_AI_GATEWAY_TOKEN`. The browser sends the Twenty session cookie (`credentials: 'include'`).

Run the gateway, then the Twenty app (`yarn start` from the repo root). Sign in first. The mock records are not Twenty rows. Set `TWENTY_API_URL` when the links should open real records. Use fictional data only.

## Booting Twenty for a signed-in run

`yarn database:init` from the repo root runs `nx database:init twenty-server` with `NX_DAEMON=false` and `NX_ISOLATE_PLUGINS=false`. The nx daemon has left `generateBarrels` sitting in `epoll` after the script itself had finished (about 1.4s when run as `tsx packages/twenty-shared/scripts/generateBarrels.ts`). The same hang hit `generate-remote-dom-elements` while starting the front: tsx was in `ep_poll` with no CPU time because nx keeps stdin open. The barrel scripts and that generator call `process.exit(0)`, and their nx commands redirect stdin from `/dev/null`. If a task still hangs, run the script directly, then:

```bash
NX_DAEMON=false NX_ISOLATE_PLUGINS=false yarn nx database:init twenty-server
```

Postgres and Redis must already be listening. `packages/twenty-utils/setup-dev-env.sh` starts them when Docker or local packages are available. On a host where service start is blocked, `pg_ctlcluster 16 main start` and `redis-server --daemonize yes` are enough. Copy `packages/twenty-server/.env.example` to `packages/twenty-server/.env` before the server boots. The dev sign-in form is prefilled; use Continue with Email.

REST posts JSON to `/rest/people`, `/rest/companies`, `/rest/opportunities`, `/rest/notes`, and `/rest/noteTargets`. GraphQL posts to `/graphql` with the matching mutations. The member credential's Twenty workspace is the one that receives the rows. The gateway does not add its `ws_*` token to the Twenty payload.
