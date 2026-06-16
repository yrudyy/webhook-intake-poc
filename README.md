# Webhook Intake POC

A small stateful Node.js application for testing webhook senders such as WordPress, Postman, and curl. The app receives webhook requests, saves each request as a timestamped local record, exposes a CRUD-like API, and shows saved records in a browser UI.

Runtime records are stored in `data.json`. That file is generated automatically and ignored by Git.

## Install

```bash
npm install
```

## Run Locally

```bash
npm run dev
```

or:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Health Check

```bash
curl http://localhost:3000/health
```

## Send a Test Webhook with curl

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": "wordpress_publish",
    "postId": 123,
    "title": "Webhook test page"
  }'
```

Then open `http://localhost:3000` and confirm the record appears.

## Test with Postman

Use:

```http
POST http://localhost:3000/webhook
```

Headers:

```http
Content-Type: application/json
```

Body:

```json
{
  "event": "postman_test",
  "message": "Webhook test from Postman"
}
```

Expected response:

```json
{
  "ok": true,
  "message": "Webhook received",
  "record": {
    "id": "uuid-value"
  }
}
```

## Connect WordPress

Configure WordPress to send publish-event webhooks to:

```text
http://localhost:3000/webhook
```

If WordPress is not running on the same machine, expose the app with a tunnel such as ngrok or Cloudflare Tunnel and use the public `/webhook` URL.

Example payload:

```json
{
  "event": "publish",
  "postId": 123,
  "postType": "page",
  "postStatus": "publish",
  "title": "Example Page",
  "url": "https://example.com/example-page/",
  "timestamp": "2026-06-16T10:30:00.000Z"
}
```

## Optional Token Protection

By default, the POC runs without authentication. To protect write endpoints, set `WEBHOOK_TOKEN`:

```bash
WEBHOOK_TOKEN=my-secret-token npm start
```

Protected requests can send the token as a header:

```http
x-webhook-token: my-secret-token
```

or as a query parameter:

```text
http://localhost:3000/webhook?token=my-secret-token
```

When records are saved, sensitive headers are omitted:

- `authorization`
- `cookie`
- `x-webhook-token`

## API

### `GET /health`

Returns service status.

### `POST /webhook`

Creates a saved webhook record.

### `GET /api/records`

Returns all records, newest first. Use `?limit=50` to limit the response.

### `GET /api/records/:id`

Returns one saved record.

### `POST /api/records`

Creates a manual record.

### `PATCH /api/records/:id`

Updates editable fields on an existing record. Supported fields are `source`, `body`, `notes`, `metadata`, `label`, `status`, and `tags`.

### `DELETE /api/records/:id`

Deletes one record.

### `DELETE /api/records`

Deletes all records.
