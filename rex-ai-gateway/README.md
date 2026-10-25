# rex-ai-gateway

Thin allowlist in front of Twenty creates. An LLM (or a curl) calls this process. The gateway turns the call into `create_person`, `create_company`, or `create_opportunity`, then asks a `TwentyCrmClient` to create the record. It never opens Twenty's database.

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
| `unmapped_intent` | the intent is not one of the create sentences below |
| `invalid_request` | the JSON body is the wrong shape |

`workspaceId` is a gateway token such as `ws_demo`, not Twenty's internal workspace uuid.

## Allowlist

Only these tools run. Anything else is refused before the client is called.

| tool | required | optional |
| --- | --- | --- |
| `create_person` | `firstName`, `lastName` | `email`, `jobTitle`, `companyId` |
| `create_company` | `name` | `domain` |
| `create_opportunity` | `name` | `amount`, `currencyCode` (default `USD` when amount is set), `stage` (default `NEW`), `companyId`, `pointOfContactId`, `closeDate` |

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

REST posts JSON to `/rest/people`, `/rest/companies`, and `/rest/opportunities`. GraphQL posts to `/graphql` with `createPerson`, `createCompany`, and `createOpportunity`. The API key's Twenty workspace is the one that receives the rows. The gateway does not add its `ws_*` token to the Twenty payload.
