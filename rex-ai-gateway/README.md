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

With the mock server running:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/ai/act \
  -H 'content-type: application/json' \
  -d '{
    "workspaceId": "ws_demo",
    "intent": "create person Ada Lovelace email ada@analytical.example"
  }'
```

The same create as an explicit tool call:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/ai/act \
  -H 'content-type: application/json' \
  -d '{
    "workspaceId": "ws_demo",
    "tools": [
      {
        "name": "create_person",
        "args": {
          "firstName": "Ada",
          "lastName": "Lovelace",
          "email": "ada@analytical.example",
          "jobTitle": "Mathematician"
        }
      }
    ]
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
| `unauthorized` | bearer token is missing or wrong (HTTP 401) |
| `idempotency_conflict` | the idempotency key was reused with a different body (HTTP 409) |
| `invalid_request` | the JSON body is the wrong shape |

`workspaceId` is a gateway token such as `ws_demo`, not Twenty's internal workspace uuid.

## Allowlist

Only these tools run. Anything else is refused before the client is called.

| tool | required | optional |
| --- | --- | --- |
| `create_person` | `firstName`, `lastName` | `email`, `jobTitle`, `companyId` (`$n` may point at an earlier create or update) |
| `create_company` | `name` | `domain` |
| `create_opportunity` | `name` | `amount`, `currencyCode` (default `USD` when amount is set), `stage` (default `NEW`), `companyId`, `pointOfContactId`, `closeDate` |
| `search_records` | `object` (`person`, `company`, or `opportunity`), `query` | `limit` (1–20, default 10) |
| `update_record` | `object`, `id`, `field`, `value`, `ifMatch` | |

`GET /v1/ai/tools` returns the same allowlist as JSON Schema for an external agent. `ifMatch` is the record etag (`v1` on the mock, `updatedAt` from Twenty). A mismatch is HTTP 412 and does not write.

Writable fields: person `firstName`, `lastName`, `email`, `jobTitle`; company `name`, `domain`; opportunity `name`, `stage`, `amount`.

`amount` is major units. The HTTP client converts it to Twenty `amountMicros` (× 1,000,000).

A non-empty `tools` array wins over `intent`. One intent maps to one tool. Batches use `tools`.

Intent sentences, in this order:

```text
create person <first> <last> [email <email>] [job <title>]
create company <name> [domain <domain>]
create opportunity <name> [amount <number>] [stage <stage>] [company <companyId>]
```

## Twenty HTTP client

Leave `TWENTY_API_URL` and `TWENTY_API_KEY` unset to keep the mock.

To forward creates, copy `.env.example` to `.env`, set a workspace API key (never commit it), and start with the env file:

```bash
npm run start:twenty
```

| variable | purpose |
| --- | --- |
| `TWENTY_API_URL` | Twenty origin, for example `http://localhost:3000` |
| `TWENTY_API_KEY` | Workspace API key. Sent as `Authorization: Bearer` |
| `TWENTY_WORKSPACE_ID` | When set, every act request must use this `workspaceId` |
| `TWENTY_API_STYLE` | `rest` (default) or `graphql` |
| `REX_AI_GATEWAY_HOST` | Default `127.0.0.1` |
| `REX_AI_GATEWAY_PORT` | Default `8787` |
| `REX_AI_GATEWAY_TOKEN` | When set, every route requires `Authorization: Bearer`. Unset keeps local dev open |
| `REX_AI_PROVIDER` | `mock` (default) or `openai` |
| `REX_AI_BASE_URL` | OpenAI-compatible origin, required when the provider is `openai` |
| `REX_AI_API_KEY` | Provider key. Never commit it |
| `REX_AI_MODEL` | Model name, required when the provider is `openai` |

The mock provider is deterministic and makes no network call. It is what `npm start` and the tests use. `openai` is any Chat Completions API: the base URL, key, and model come from the environment.

## Plan, then confirm

`POST /v1/ai/plan` interprets plain English and returns a proposal. It does not write. The command bar shows that proposal and, only after Confirm, posts the same tools to `POST /v1/ai/act` with `confirmed: true`.

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

A named update that matches zero records is `not_found`. More than one match is `ambiguous_intent`. Deletes, exports, and credential requests are `unsafe_intent`. The strict `create person|company|opportunity` sentences from the table above still run immediately on `POST /v1/ai/act` so existing tool calls keep working. Natural language goes through `/v1/ai/plan` first.

`Idempotency-Key` on `POST /v1/ai/act` replays the stored response when the body matches, and returns 409 `idempotency_conflict` when the same key is reused with a different body. The store is in memory. `GET /v1/ai/audit` lists who (`X-Rex-Actor`), what, when, and the result. These three ideas are adapted from rex-crm-public's bearer API auth, `Idempotency-Key`, and `If-Match` on writes. This gateway keeps them in process instead of in that app's SQL tables, and a missing bearer token does not fall back to a session cookie.

## Command bar

In the Twenty web app, Ctrl+Shift+K or ⌘⇧K opens the AI command bar (Ctrl/Cmd+K is already the command menu, and Ctrl/Cmd+J is the log console). The button labelled "AI command" opens it too. The bar calls this gateway at `http://127.0.0.1:8787` and workspace `ws_demo` unless `window._env_` sets `REX_AI_GATEWAY_URL`, `REX_AI_WORKSPACE_ID`, or `REX_AI_GATEWAY_TOKEN`.

Run the gateway, then the Twenty app (`yarn start` from the repo root). The mock records are not Twenty rows, so the links use the gateway ids. Point `TWENTY_API_URL` and `TWENTY_API_KEY` at a workspace when the links should open real records. Use fictional data only.

REST posts JSON to `/rest/people`, `/rest/companies`, and `/rest/opportunities`. GraphQL posts to `/graphql` with `createPerson`, `createCompany`, and `createOpportunity`. The API key's Twenty workspace is the one that receives the rows. The gateway does not add its `ws_*` token to the Twenty payload.
