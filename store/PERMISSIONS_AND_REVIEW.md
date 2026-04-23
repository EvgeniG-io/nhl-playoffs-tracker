# Host permissions, review, and optional permissions

Official reference: [Permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings) (what users see and how warnings are determined).

This extension’s **`manifest.json`** uses **narrow `host_permissions`** that match only the NHL **`api-web`** paths the code calls (no domain-wide `/*` on the host root).

## What this build uses (NHL Playoff Tracker)

| API path (under `https://api-web.nhle.com`) | Used for |
|---------------------------------------------|-----------|
| `/v1/standings/*` | Standings snapshots (including date walk-back for empty days) |
| `/v1/club-schedule-season/*` | Per-team full-season schedule |
| `/v1/scoreboard/*` | Playoff series seed labels merged into schedule rows |

## Narrow patterns vs broad wildcard

Replacing:

`https://api-web.nhle.com/*`

with explicit path prefixes **documents intent to reviewers and users**: only these read-only JSON endpoints are needed. It can **reduce** perceived scope compared to a blanket host wildcard. It does **not** guarantee a particular review timeline; Google’s review policies and risk signals change over time.

## Optional host permissions (`optional_host_permissions`)

You **may** move host access to `optional_host_permissions` and call `chrome.permissions.request({ origins: [...] })` after a **user gesture** (e.g. a button in the popup). Effects:

| Benefit | Tradeoff |
|---------|----------|
| Install-time permission surface can be smaller until the user opts in. | **No `fetch()` to those URLs until granted** — you must add UI: e.g. “Enable NHL data” → request → then load standings/schedules. |
| Clear story: access only after explicit consent. | More code and testing; users who ignore the button see nothing. |

**Important:** Optional permissions are **not** a documented guarantee to “skip” in-depth review or to always shorten review. Treat any review-time win as **possible**, not promised.

### If you adopt optional permissions later

1. In **`manifest.json`**: remove fixed `host_permissions` for NHL hosts, add matching `optional_host_permissions` patterns (same path prefixes as today).
2. In **`popup.js`**: before the first `fetch`, call `chrome.permissions.request({ origins: [ ... three patterns ... ] }, callback)` from a click handler.
3. Handle `granted === false` with an inline message.

The **`chrome.permissions`** API is available to extension pages; you do **not** need broad extras like `tabs` or `identity` for this pattern.

## Permission justification (Developer Dashboard)

Use text tied to **these exact paths**, for example:

> This extension only uses **read-only HTTPS GET** requests to **`api-web.nhle.com`** under **`/v1/standings/*`**, **`/v1/club-schedule-season/*`**, and **`/v1/scoreboard/*`** to derive playoff-position teams and show schedules and series context. No user data is collected or transmitted to our servers; responses are public NHL JSON consumed only in the popup UI.

Adjust wording if you change endpoints.

## Clean manifest

Keep **`manifest.json`** minimal: no unused `permissions` entries (`storage`, `tabs`, `identity`, etc.) unless you add features that require them.
