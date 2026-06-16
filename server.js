const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, "data.json");
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "x-webhook-token"]);

app.use(express.json({ limit: "2mb", type: ["application/json", "application/*+json"] }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.text({ limit: "2mb", type: "*/*" }));

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ records: [] }, null, 2) + "\n");
  }
}

function readRecords() {
  ensureDataFile();

  const raw = fs.readFileSync(DATA_FILE, "utf8");
  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.records)) {
    return parsed.records;
  }

  throw new Error("data.json must contain an object with a records array");
}

function writeRecords(records) {
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify({ records }, null, 2) + "\n");
  fs.renameSync(tmpFile, DATA_FILE);
}

function sanitizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase())),
  );
}

function getBody(req) {
  if (req.body === undefined || req.body === "") {
    return null;
  }

  return req.body;
}

function getSafeRequestPath(req) {
  try {
    const url = new URL(req.originalUrl, "http://localhost");
    url.searchParams.delete("token");
    return `${url.pathname}${url.search}`;
  } catch (_error) {
    return req.path;
  }
}

function createRecord(req, source, body = getBody(req)) {
  return {
    id: crypto.randomUUID(),
    source,
    createdAt: new Date().toISOString(),
    method: req.method,
    path: getSafeRequestPath(req),
    ip: req.ip,
    headers: sanitizeHeaders(req.headers),
    body,
  };
}

function saveNewRecord(record) {
  const records = readRecords();
  records.unshift(record);
  writeRecords(records);
  return record;
}

function parseLimit(value) {
  if (value === undefined) {
    return null;
  }

  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    return null;
  }

  return Math.min(limit, 1000);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireWebhookToken(req, res, next) {
  const configuredToken = process.env.WEBHOOK_TOKEN;
  if (!configuredToken) {
    return next();
  }

  const suppliedToken = req.get("x-webhook-token") || req.query.token;
  if (suppliedToken === configuredToken) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: "A valid webhook token is required",
  });
}

function findRecord(records, id) {
  return records.find((record) => record.id === id);
}

function getManualBody(req) {
  if (isPlainObject(req.body) && Object.prototype.hasOwnProperty.call(req.body, "body")) {
    return req.body.body;
  }

  return getBody(req);
}

function getManualSource(req) {
  if (isPlainObject(req.body) && typeof req.body.source === "string" && req.body.source.trim()) {
    return req.body.source.trim();
  }

  return "manual";
}

function applyRecordPatch(record, patch) {
  if (!isPlainObject(patch)) {
    return false;
  }

  const allowedFields = new Set(["source", "body", "notes", "metadata", "label", "status", "tags"]);
  let changed = false;

  for (const [key, value] of Object.entries(patch)) {
    if (allowedFields.has(key)) {
      record[key] = value;
      changed = true;
    }
  }

  if (changed) {
    record.updatedAt = new Date().toISOString();
  }

  return changed;
}

app.get("/", (_req, res) => {
  res.type("html").send(renderPage());
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "webhook-state-poc",
    time: new Date().toISOString(),
  });
});

app.post("/webhook", requireWebhookToken, (req, res, next) => {
  try {
    const record = saveNewRecord(createRecord(req, "webhook"));

    res.status(201).json({
      ok: true,
      message: "Webhook received",
      record: {
        id: record.id,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/records", (req, res, next) => {
  try {
    const records = readRecords();
    const limit = parseLimit(req.query.limit);
    const returnedRecords = limit ? records.slice(0, limit) : records;

    res.json({
      ok: true,
      count: returnedRecords.length,
      records: returnedRecords,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/records/:id", (req, res, next) => {
  try {
    const record = findRecord(readRecords(), req.params.id);
    if (!record) {
      return res.status(404).json({ ok: false, error: "Record not found" });
    }

    return res.json({ ok: true, record });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/records", requireWebhookToken, (req, res, next) => {
  try {
    const record = saveNewRecord(createRecord(req, getManualSource(req), getManualBody(req)));

    res.status(201).json({
      ok: true,
      message: "Record created",
      record,
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/records/:id", requireWebhookToken, (req, res, next) => {
  try {
    const records = readRecords();
    const record = findRecord(records, req.params.id);
    if (!record) {
      return res.status(404).json({ ok: false, error: "Record not found" });
    }

    if (!applyRecordPatch(record, req.body)) {
      return res.status(400).json({
        ok: false,
        error: "Patch body must include at least one supported field",
        supportedFields: ["source", "body", "notes", "metadata", "label", "status", "tags"],
      });
    }

    writeRecords(records);
    return res.json({ ok: true, record });
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/records/:id", requireWebhookToken, (req, res, next) => {
  try {
    const records = readRecords();
    const nextRecords = records.filter((record) => record.id !== req.params.id);
    if (nextRecords.length === records.length) {
      return res.status(404).json({ ok: false, error: "Record not found" });
    }

    writeRecords(nextRecords);
    return res.json({ ok: true, deleted: 1 });
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/records", requireWebhookToken, (_req, res, next) => {
  try {
    writeRecords([]);
    res.json({ ok: true, deleted: "all" });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      ok: false,
      error: "Invalid request body",
    });
  }

  console.error(error);
  return res.status(500).json({
    ok: false,
    error: "Internal server error",
  });
});

function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Webhook Intake POC</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --surface: #ffffff;
      --surface-muted: #eef2f5;
      --text: #17202a;
      --muted: #5f6f7f;
      --border: #d9e0e7;
      --primary: #006d77;
      --primary-strong: #004f57;
      --danger: #b42318;
      --danger-bg: #fff0ee;
      --ok-bg: #eaf7ef;
      --ok-text: #146c43;
      --shadow: 0 12px 30px rgba(20, 29, 38, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-width: 320px;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }

    button,
    textarea,
    input {
      font: inherit;
    }

    button {
      min-height: 40px;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 0 14px;
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      white-space: nowrap;
    }

    button:hover {
      border-color: var(--primary);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }

    .primary {
      background: var(--primary);
      color: #ffffff;
    }

    .primary:hover {
      background: var(--primary-strong);
    }

    .danger {
      background: var(--danger-bg);
      color: var(--danger);
      border-color: #f1beb8;
    }

    .shell {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 40px;
    }

    .topbar {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 18px;
      align-items: end;
      margin-bottom: 20px;
    }

    h1 {
      margin: 0 0 8px;
      font-size: clamp(1.9rem, 4vw, 3rem);
      line-height: 1.05;
      letter-spacing: 0;
    }

    .endpoint {
      display: inline-flex;
      max-width: 100%;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      background: var(--surface-muted);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px 10px;
    }

    .endpoint code {
      overflow-wrap: anywhere;
      color: var(--text);
    }

    .status {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 0 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(300px, 420px) 1fr;
      gap: 18px;
      align-items: start;
    }

    .panel,
    .record {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .panel {
      padding: 16px;
      position: sticky;
      top: 16px;
    }

    .panel h2,
    .records-head h2 {
      margin: 0;
      font-size: 1rem;
      letter-spacing: 0;
    }

    .field {
      display: grid;
      gap: 6px;
      margin-top: 14px;
    }

    label {
      color: var(--muted);
      font-size: 0.85rem;
      font-weight: 650;
    }

    textarea,
    input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: #fbfcfd;
      color: var(--text);
      padding: 10px;
    }

    textarea {
      min-height: 220px;
      resize: vertical;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 0.9rem;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 14px;
    }

    .records-area {
      min-width: 0;
    }

    .records-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .count {
      color: var(--muted);
      font-size: 0.9rem;
    }

    .records {
      display: grid;
      gap: 12px;
    }

    .empty {
      min-height: 160px;
      display: grid;
      place-items: center;
      color: var(--muted);
      background: var(--surface);
      border: 1px dashed var(--border);
      border-radius: 8px;
    }

    .record {
      padding: 14px;
      display: grid;
      gap: 12px;
    }

    .record-top {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: start;
    }

    .meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    .badge {
      min-height: 26px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--border);
      padding: 0 9px;
      background: var(--surface-muted);
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 700;
    }

    .badge.method {
      background: var(--ok-bg);
      color: var(--ok-text);
      border-color: #b9e4ca;
    }

    .record-id {
      margin-top: 6px;
      color: var(--muted);
      font-size: 0.85rem;
      overflow-wrap: anywhere;
    }

    details {
      border-top: 1px solid var(--border);
      padding-top: 10px;
    }

    summary {
      cursor: pointer;
      color: var(--muted);
      font-weight: 700;
    }

    pre {
      overflow: auto;
      max-height: 340px;
      margin: 8px 0 0;
      border-radius: 7px;
      background: #101820;
      color: #edf5f6;
      padding: 12px;
      font-size: 0.82rem;
      line-height: 1.45;
    }

    .toast {
      min-height: 24px;
      margin-top: 12px;
      color: var(--muted);
      font-size: 0.9rem;
    }

    .toast.ok {
      color: var(--ok-text);
    }

    .toast.error {
      color: var(--danger);
    }

    @media (max-width: 860px) {
      .topbar,
      .grid {
        grid-template-columns: 1fr;
      }

      .panel {
        position: static;
      }

      .records-head,
      .record-top {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 520px) {
      .shell {
        width: min(100% - 20px, 1180px);
        padding-top: 18px;
      }

      .actions button,
      .record-top button {
        flex: 1 1 auto;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>Webhook Intake POC</h1>
        <div class="endpoint">
          <span>Endpoint</span>
          <code id="endpointUrl"></code>
        </div>
      </div>
      <div class="status" id="status">Loading</div>
    </header>

    <section class="grid">
      <form class="panel" id="testForm">
        <h2>Manual Test</h2>
        <div class="field">
          <label for="payload">Payload</label>
          <textarea id="payload" spellcheck="false">{
  "event": "wordpress_publish",
  "postId": 123,
  "title": "Webhook test page"
}</textarea>
        </div>
        <div class="field">
          <label for="token">Token</label>
          <input id="token" type="password" autocomplete="off">
        </div>
        <div class="actions">
          <button class="primary" type="submit">Send test</button>
          <button type="button" id="refreshButton">Refresh</button>
          <button class="danger" type="button" id="clearButton">Clear all</button>
        </div>
        <div class="toast" id="toast"></div>
      </form>

      <section class="records-area">
        <div class="records-head">
          <h2>Saved Records</h2>
          <span class="count" id="recordCount">0 records</span>
        </div>
        <div class="records" id="records"></div>
      </section>
    </section>
  </main>

  <script>
    const endpointUrl = document.querySelector("#endpointUrl");
    const statusEl = document.querySelector("#status");
    const recordCountEl = document.querySelector("#recordCount");
    const recordsEl = document.querySelector("#records");
    const toastEl = document.querySelector("#toast");
    const payloadEl = document.querySelector("#payload");
    const tokenEl = document.querySelector("#token");
    const formEl = document.querySelector("#testForm");
    const refreshButton = document.querySelector("#refreshButton");
    const clearButton = document.querySelector("#clearButton");

    endpointUrl.textContent = new URL("/webhook", window.location.origin).toString();

    function setToast(message, type = "") {
      toastEl.textContent = message;
      toastEl.className = type ? "toast " + type : "toast";
    }

    function setBusy(isBusy) {
      formEl.querySelectorAll("button").forEach((button) => {
        button.disabled = isBusy;
      });
    }

    function headers() {
      const currentHeaders = { "Content-Type": "application/json" };
      if (tokenEl.value) {
        currentHeaders["x-webhook-token"] = tokenEl.value;
      }
      return currentHeaders;
    }

    function formatJson(value) {
      return JSON.stringify(value, null, 2);
    }

    function el(tag, options = {}) {
      const node = document.createElement(tag);
      if (options.className) {
        node.className = options.className;
      }
      if (options.text !== undefined) {
        node.textContent = options.text;
      }
      return node;
    }

    function renderRecord(record) {
      const card = el("article", { className: "record" });
      const top = el("div", { className: "record-top" });
      const info = el("div");
      const meta = el("div", { className: "meta" });

      meta.append(
        el("span", { className: "badge", text: record.source || "unknown" }),
        el("span", { className: "badge method", text: record.method || "REQUEST" }),
        el("span", { className: "badge", text: record.path || "/" }),
        el("span", { className: "badge", text: new Date(record.createdAt).toLocaleString() }),
      );

      info.append(meta, el("div", { className: "record-id", text: record.id }));

      const deleteButton = el("button", { className: "danger", text: "Delete" });
      deleteButton.type = "button";
      deleteButton.addEventListener("click", async () => {
        await deleteRecord(record.id);
      });

      top.append(info, deleteButton);
      card.append(top, detailsBlock("Body JSON", record.body), detailsBlock("Headers JSON", record.headers));
      return card;
    }

    function detailsBlock(label, value) {
      const details = document.createElement("details");
      details.open = label === "Body JSON";
      const summary = el("summary", { text: label });
      const pre = el("pre", { text: formatJson(value) });
      details.append(summary, pre);
      return details;
    }

    async function requestJson(url, options = {}) {
      const response = await fetch(url, options);
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || "Request failed");
      }
      return body;
    }

    async function loadRecords() {
      try {
        const data = await requestJson("/api/records");
        statusEl.textContent = "Healthy";
        recordCountEl.textContent = data.count === 1 ? "1 record" : data.count + " records";
        recordsEl.replaceChildren();

        if (!data.records.length) {
          recordsEl.append(el("div", { className: "empty", text: "No records yet" }));
          return;
        }

        data.records.forEach((record) => recordsEl.append(renderRecord(record)));
      } catch (error) {
        statusEl.textContent = "Error";
        setToast(error.message, "error");
      }
    }

    async function sendTest(event) {
      event.preventDefault();
      setBusy(true);
      setToast("");

      try {
        const parsed = JSON.parse(payloadEl.value);
        const data = await requestJson("/webhook", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(parsed),
        });

        setToast("Saved " + data.record.id, "ok");
        await loadRecords();
      } catch (error) {
        setToast(error.message, "error");
      } finally {
        setBusy(false);
      }
    }

    async function deleteRecord(id) {
      setBusy(true);
      setToast("");

      try {
        await requestJson("/api/records/" + encodeURIComponent(id), {
          method: "DELETE",
          headers: headers(),
        });
        setToast("Deleted record", "ok");
        await loadRecords();
      } catch (error) {
        setToast(error.message, "error");
      } finally {
        setBusy(false);
      }
    }

    async function clearRecords() {
      setBusy(true);
      setToast("");

      try {
        await requestJson("/api/records", {
          method: "DELETE",
          headers: headers(),
        });
        setToast("Cleared records", "ok");
        await loadRecords();
      } catch (error) {
        setToast(error.message, "error");
      } finally {
        setBusy(false);
      }
    }

    formEl.addEventListener("submit", sendTest);
    refreshButton.addEventListener("click", loadRecords);
    clearButton.addEventListener("click", clearRecords);
    loadRecords();
    window.setInterval(loadRecords, 5000);
  </script>
</body>
</html>`;
}

ensureDataFile();

app.listen(PORT, () => {
  console.log(`Webhook Intake POC listening on http://localhost:${PORT}`);
});
