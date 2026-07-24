# Altrone — Integration API Spec

**Version 1.0**

A document for developers of a CRM system that wants to connect to Altrone. You don't need to
understand Altrone's internals — this describes the **single data format** your side must expose.
Implement it once (a "bridge"), and it works.

---

## 1. What Altrone is and why this integration

Altrone is an analytics layer that sits on top of your CRM. Once connected, it reads your sales
data (leads, calls, outcomes) and turns it into live dashboards, per-salesperson performance
metrics, and automatic recommendations for the sales manager. To connect, your CRM **doesn't need
to know anything about how Altrone works** — you just expose your data in one common format
described below. Instead of us writing a separate adapter for each CRM, you write a small "bridge"
to our standard once, and the connection is done.

---

## 2. Authorization

Two modes are supported. Implementing **either one** is enough; you may do both.

### Mode A — Pull (default, simplest)

Altrone periodically calls **read-only** endpoints on your side. You authenticate our requests
with a **static API key** you issue to us once. The key goes in the `Authorization` header:

```http
GET /hunter/leads?updated_since=2026-07-16T00:00:00Z HTTP/1.1
Host: crm.yourcompany.com
Authorization: Bearer hunter_live_9f2b7c8a1d4e...
Accept: application/json
```

Rules:
- You generate the key and hand it to us once (over a secure channel). Rotate anytime — just tell us the new one.
- HTTPS only.
- Reject requests without a valid key with `401 Unauthorized`.

### Mode B — Push via webhook (optional, for freshness)

When data changes on your side, you can send the changed record to a URL we provide, with a
signature of the body in the header:

```http
POST https://ingest.hunterai.example/v1/webhook HTTP/1.1
Content-Type: application/json
X-Hunter-Signature: sha256=3a7f...   // HMAC-SHA256 of the body with a shared secret
```

Push reduces latency but is **optional** — Pull alone is enough to get started.

---

## 3. Required entities and formats

Common conventions:
- **All dates/times** — ISO 8601 in UTC: `"2026-07-16T09:30:00Z"`.
- **All `id`s** — strings (a number as a string is fine): `"48213"`.
- **Phone numbers** — international format where possible: `"+998901234567"`.
- Encoding — UTF-8.

### 3a. Lead / Deal

The core entity. The key point is the `status.type` field: mark each status as `open` (in progress),
`won` (**final "sale made" status**), or `lost` (**final "lost" status**). This is how we know a sale
happened **without guessing** from the name.

```json
{
  "id": "48213",
  "created_at": "2026-07-14T06:12:00Z",
  "updated_at": "2026-07-16T09:30:00Z",
  "responsible_employee_id": "1007",
  "contact_phone": "+998901234567",
  "status": {
    "id": "142",
    "name": "Оплачено",
    "type": "won"
  },
  "loss_reason": null,
  "payment": {
    "is_paid": true,
    "amount": 4500000,
    "currency": "UZS",
    "paid_at": "2026-07-16T09:28:00Z"
  }
}
```

Example of a lost lead:

```json
{
  "id": "48090",
  "created_at": "2026-07-13T10:05:00Z",
  "updated_at": "2026-07-15T14:20:00Z",
  "responsible_employee_id": "1007",
  "contact_phone": "+998907654321",
  "status": { "id": "143", "name": "Закрыто", "type": "lost" },
  "loss_reason": { "id": "22", "name": "Неверный номер" },
  "payment": null
}
```

Required fields:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique lead identifier |
| `created_at` | datetime | When the lead was created |
| `updated_at` | datetime | Last change (needed for incremental sync) |
| `responsible_employee_id` | string | `id` of the responsible employee (see 3c) |
| `contact_phone` | string \| null | Contact's phone number |
| `status.id` | string | `id` of the current status |
| `status.name` | string | Human-readable status name |
| `status.type` | enum | `open` \| `won` \| `lost` — **required** |
| `loss_reason` | object \| null | Loss reason (only if `status.type = lost`) |
| `payment` | object \| null | Payment fact (see 3d, optional) |

### 3b. Call

```json
{
  "id": "c-99120",
  "lead_id": "48213",
  "employee_id": "1007",
  "direction": "outbound",
  "started_at": "2026-07-16T08:41:12Z",
  "duration_seconds": 74,
  "answered": true
}
```

Required fields:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique call identifier |
| `lead_id` | string | Which lead the call belongs to |
| `employee_id` | string | Who made/received the call |
| `direction` | enum | `inbound` \| `outbound` |
| `started_at` | datetime | Call start time |
| `duration_seconds` | integer | Talk duration in seconds (0 if not answered) |
| `answered` | boolean | Whether the call was answered (connection made) |

### 3c. Employee

```json
{
  "id": "1007",
  "name": "Ivan Petrov",
  "role": "sales"
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique employee identifier |
| `name` | string | Name (as shown in reports) |
| `role` | string \| null | Role, if any (`sales`, `manager`, etc.) — optional |

### 3d. Payment (optional, but important to understand)

If your CRM **tracks the payment fact separately** (not just "deal won"), be sure to pass it in the
lead's `payment` field. Why this matters, in plain terms:

> **"Won" ≠ "money received".** "Won" means the purchase was agreed in negotiations. But the customer
> may not have paid yet, may pay partially, or may cancel. If we count revenue by the "won" status,
> the numbers are inflated and decisions are inaccurate. When there's a real payment fact, the
> metrics become honest: we see not "promised to buy" but "money actually arrived".

```json
"payment": {
  "is_paid": true,
  "amount": 4500000,
  "currency": "UZS",
  "paid_at": "2026-07-16T09:28:00Z"
}
```

If you don't have such tracking — pass `"payment": null`. Then we work by the sale status (this is
acceptable, just less precise). Nothing needs to be invented.

---

## 4. Data completeness requirement

**This is a mandatory rule, not a recommendation.**

Every list response (leads, calls, employees) **must include an `is_complete` field** (boolean). If
for any reason you couldn't return all the data — a failure, a rate limit, a timeout, a partial
export — return `is_complete: false` and, if possible, a short explanation in `note`.

```json
{
  "is_complete": false,
  "note": "rate limit reached, returned first 500 of ~1200 records",
  "leads": [ /* ... partial list ... */ ]
}
```

**Why this matters** (in plain terms): Altrone builds management decisions on this data — who among
the salespeople is falling behind, where money is leaking, what to advise the manager. If you
silently return an **incomplete** list without warning, the system will treat it as complete and draw
a **wrong conclusion** (for example, it will decide a salesperson didn't make calls, when the call
data simply didn't arrive). The explicit `is_complete: false` flag is a signal: "trust this data with
caution, part of it is missing." Then we honestly mark the metric as incomplete instead of producing
a false conclusion about a person or a team.

**It's better to say "the data is incomplete" than to silently return half of it.**

---

## 5. Full request/response example (end-to-end)

A single endpoint returning all entities for a period at once (separate endpoints are fine too — see FAQ).

**Request from Altrone:**

```http
GET /hunter/export?updated_since=2026-07-16T00:00:00Z HTTP/1.1
Host: crm.yourcompany.com
Authorization: Bearer hunter_live_9f2b7c8a1d4e...
Accept: application/json
```

**Response from your CRM (`200 OK`):**

```json
{
  "is_complete": true,
  "generated_at": "2026-07-16T09:35:00Z",
  "employees": [
    { "id": "1007", "name": "Ivan Petrov", "role": "sales" },
    { "id": "1008", "name": "Olga Ким", "role": "sales" }
  ],
  "leads": [
    {
      "id": "48213",
      "created_at": "2026-07-14T06:12:00Z",
      "updated_at": "2026-07-16T09:30:00Z",
      "responsible_employee_id": "1007",
      "contact_phone": "+998901234567",
      "status": { "id": "142", "name": "Оплачено", "type": "won" },
      "loss_reason": null,
      "payment": { "is_paid": true, "amount": 4500000, "currency": "UZS", "paid_at": "2026-07-16T09:28:00Z" }
    },
    {
      "id": "48090",
      "created_at": "2026-07-13T10:05:00Z",
      "updated_at": "2026-07-15T14:20:00Z",
      "responsible_employee_id": "1008",
      "contact_phone": "+998907654321",
      "status": { "id": "143", "name": "Закрыто", "type": "lost" },
      "loss_reason": { "id": "22", "name": "Неверный номер" },
      "payment": null
    }
  ],
  "calls": [
    {
      "id": "c-99120",
      "lead_id": "48213",
      "employee_id": "1007",
      "direction": "outbound",
      "started_at": "2026-07-16T08:41:12Z",
      "duration_seconds": 74,
      "answered": true
    },
    {
      "id": "c-99121",
      "lead_id": "48090",
      "employee_id": "1008",
      "direction": "outbound",
      "started_at": "2026-07-15T13:02:00Z",
      "duration_seconds": 0,
      "answered": false
    }
  ]
}
```

That's it. Implement this response (plus the key check from section 2) and you're connected.

---

## 6. FAQ

**Q: We don't have a separate "loss reason" field. What do we do?**
Pass `"loss_reason": null`. Loss-reason metrics simply won't be built, but everything else
(conversion, call-through, speed) works. If the field appears later — just start sending it; nothing
needs to change on our side.

**Q: We use GraphQL / gRPC / a file export, not REST. Will that work?**
The contract is the **data format** (the JSON structures above), not a specific transport. The
simplest option is a plain HTTPS endpoint (Pull) or a webhook (Push). If you fundamentally use
something else — reach out, we'll agree on it: the main thing is that the fields and their meaning
match this document.

**Q: How often will you call our API?**
The exact frequency is **agreed individually with each client** — it depends on your API's limits and
on how fresh the data needs to be. We always pass `updated_since` so you return only what changed
since last time — no need to export the full base every time. Tell us your request limits up front,
and we'll pick a mode that's comfortable for your side.

**Q: We don't track payment — only "deal won". Is that a problem?**
No. Pass `"payment": null` and we work by the `type: "won"` status. Just remember: revenue figures
will reflect "agreed to buy" rather than "money arrived" (see section 3d). As soon as you have a
payment fact — start sending `payment`, and the metrics become more precise automatically.

**Q: What counts as `status.type = won` / `lost` if there are many statuses?**
`won` is the final "sale made" status (it can be named anything on your side — "Paid", "Success",
"Closed Won"). `lost` is the final "deal lost / closed without a sale" status. All intermediate ones
("New", "In progress", "Call back", etc.) are `open`. If there are several final statuses — mark each
with the appropriate type.

**Q: Do we need to send the whole history at once?**
For the start it's useful to send historical data (e.g., the last 1–3 months) — in one first large
request without `updated_since`. After that it's just the increment via `updated_since`. If the
history is large — send it in pages and set `is_complete: false` on incomplete pages.

---

*Questions about the integration — reach out, we'll help you set up the "bridge".*
