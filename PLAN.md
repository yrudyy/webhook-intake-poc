# Webhook Intake POC - Implementation Plan

## Goal

Create a small stateful application that can be used to test webhooks.

The app should:

- Receive webhook requests from WordPress, Postman, curl, or any other webhook sender.
- Save each webhook request as a timestamped record.
- Expose a CRUD-like API for managing records.
- Show saved webhook records on a simple webpage.
- Persist state locally using a JSON file.
- Be simple enough to deploy, inspect, and extend later.

## Tech Stack

- Node.js
- Express
- Local JSON file storage
- Vanilla HTML/CSS/JavaScript for the UI

No database is required for the first POC.

## Files

```text
webhook-intake-poc/
├── package.json
├── server.js
├── data.json
├── .gitignore
├── README.md
└── PLAN.md
```

`data.json` is generated automatically at runtime and ignored by Git.

## Core Features

### Webhook Receiver

`POST /webhook` accepts JSON and other common webhook body types. Each request is saved with:

- Unique ID
- Timestamp
- HTTP method
- Request path
- Request headers
- Request body
- Source label
- IP address

Sensitive headers are not stored.

### Stateful Storage

Records are stored in local `data.json` as:

```json
{
  "records": []
}
```

Records are saved newest first.

### Simple Web UI

`GET /` displays:

- App title
- Webhook endpoint URL
- Manual test payload textarea
- Button to send a test webhook
- Button to refresh records
- Button to delete all records
- List of saved webhook records

Each record card shows source, timestamp, method, request path, record ID, body JSON, headers JSON, and a delete button. The page auto-refreshes every few seconds.

## API Endpoints

- `GET /health`
- `POST /webhook`
- `GET /api/records`
- `GET /api/records/:id`
- `POST /api/records`
- `PATCH /api/records/:id`
- `DELETE /api/records/:id`
- `DELETE /api/records`

## Optional Token Protection

When `WEBHOOK_TOKEN` is configured, write endpoints require either:

```http
x-webhook-token: my-secret-token
```

or:

```text
/webhook?token=my-secret-token
```

## Acceptance Criteria

- The app starts successfully with `npm start`.
- `GET /health` returns a valid response.
- `POST /webhook` creates a saved record.
- Records are persisted in `data.json`.
- `GET /api/records` returns saved records.
- The homepage displays saved records.
- Records can be deleted from the UI.
- Records can be cleared via API.
- A WordPress publish event can trigger a visible record.
