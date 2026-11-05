# rex-ai-gateway

Thin allowlist in front of Twenty. An LLM (or the AI command bar) calls this process. The gateway turns the call into an allowlisted tool, then asks a `TwentyCrmClient` to read or write the record. It never opens Twenty's database.

This package is Rex glue beside Twenty. It is not part of the Yarn workspace and it does not build the Twenty monorepo. Twenty stays under its own license (AGPL-3.0). The gateway is added in this same AGPL-3.0 tree.

Fictional data only. The samples below use `ws_demo` and `*.example` addresses.

## Run

Requires Node.js 22 or newer. From this directory:

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
| `unsafe_intent` | the planner refuses a delete, export, or credential request |
| `ambiguous_intent` | an update does not name exactly one record |
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
| `create_person` | `firstName`, `lastName` | `email`, `jobTitle`, `phone` (`+1 4155550134`), `companyId` (`$n` may point at an earlier create or update) |
| `create_company` | `name` | `domain` |
| `create_opportunity` | `name` | `amount`, `currencyCode` (default `USD` when amount is set), `stage` (`NEW`, `SCREENING`, `MEETING`, `PROPOSAL`, or `CUSTOMER`; default `NEW`), `companyId`, `pointOfContactId`, `closeDate` |
| `create_note` | `body`, `targetObject` | `title`, `targetId` or `targetQuery` (`$n` may point at an earlier create or update) |
| `search_records` | `object` (`person`, `company`, or `opportunity`), `query` | `limit` (1–20, default 10) |
| `update_record` | `object`, `field`, `value`, and either `id` or `query` | `ifMatch` (filled from the current record when the preview can load it) |

`GET /v1/ai/tools` returns the same allowlist as JSON Schema for an external agent. It uses the same bearer check as act and audit. `ifMatch` is the record etag (`v1` on the mock, `updatedAt` from Twenty). A mismatch is HTTP 412 and does not write. Twenty's REST API ignores an `If-Match` header, so the HTTP client sends the etag as `updatedAt[eq]` on an update-many filter. Zero matched rows means nothing was written.

Writable fields: person `firstName`, `lastName`, `email`, `jobTitle`, `phone`; company `name`, `domain`, `accountOwner` (also accepted as `owner`); opportunity `name`, `stage`, `amount`, `owner`. `stage` must be one of the Twenty opportunity values above. `owner` and `accountOwner` are `me` (the signed-in member) or a workspace member id. `phone` is a calling code the gateway knows (`+1`, `+33`, `+44`, `+49`, `+61`) plus the national number.

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
| `REX_AI_PROVIDER` | `mock` (default) or `openai` |
| `REX_AI_BASE_URL` | Public OpenAI-compatible origin, required when the provider is `openai`. Private, loopback, and metadata hosts are refused, and redirects are not followed |
| `REX_AI_API_KEY` | Provider key. Never commit it |
| `REX_AI_MODEL` | Model name, required when the provider is `openai` |

The mock provider is deterministic and makes no network call. It is what `npm start` and the tests use. `openai` is any Chat Completions API: the base URL, key, and model come from the environment.

## Plan, then confirm

`POST /v1/ai/plan` interprets plain English and returns a proposal. It does not write. The headline is built from the validated tools, not from the model's own summary. The command bar shows that proposal and, only after Confirm, posts `proposal.id` to `POST /v1/ai/act` with `confirmed: true`. Act runs the stored tools. A tools array on act, or `confirmed` without a live preview id, is `confirmation_required` and does not write. Cancel sends nothing.

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
```

A named update that matches zero records is `not_found`. More than one match is a preview with choices. Confirm sends `choiceId`. Nothing is written until one record is chosen. Deletes, exports, and credential requests are `unsafe_intent`.

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
