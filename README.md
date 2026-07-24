# browser-fetch

Fresh, isolated Chromium price observations for LaptopValue, using Playwright on standard GitHub-hosted Ubuntu runners.

## What it does

- Opens each product in a fresh browser context with UK locale and Europe/London timezone.
- Extracts price candidates from Product JSON-LD, price metadata and visible price elements.
- Checks an expected SKU and/or EAN before accepting the observation.
- Records the final URL, HTTP status, product identifiers, availability and a screenshot.
- Writes JSON evidence to a GitHub Actions artifact.
- Optionally inserts the same observation into Supabase.
- Rejects URLs outside an explicit retailer-domain allowlist.
- Does not attempt to bypass CAPTCHAs or retailer access controls.

A new browser context is created for every product, so cookies, cache and local storage do not carry between checks. Batch jobs reuse the Chromium process to avoid repeatedly paying browser startup time.

## Three ways to run it

### 1. From ChatGPT through an owner issue

Create an issue whose title begins with `[fetch]` and whose entire body is JSON:

```json
{
  "id": "catalogue-record-id",
  "retailer": "Currys",
  "url": "https://www.currys.co.uk/your-product-page",
  "expectedSku": "EXACT-SKU",
  "expectedEan": "1234567890123"
}
```

Only an issue opened by the repository owner is allowed to start the job. The workflow posts the structured result back as an issue comment and closes the issue. This allows a connected GitHub assistant to request a check and read the evidence without a public browser API.

### 2. Manually

Open **Actions → Fetch one product price → Run workflow** and enter a product URL plus its exact SKU and/or EAN.

### 3. Daily batch

Add targets to `config/targets.json`. The scheduled workflow runs daily at 05:17 UTC and divides the list across four standard Ubuntu jobs.

## Supabase setup

Run `supabase/001_browser_price_observations.sql` in the Supabase SQL editor, then add these repository secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional repository variables:

- `SUPABASE_TABLE` — defaults to `browser_price_observations`
- `ALLOWED_HOSTS` — comma-separated additional approved domains

The service-role key must only be stored as a GitHub Actions secret. Never put it in source code, an issue, a workflow input or `config/targets.json`.

## Local use

```bash
npm install
npx playwright install --with-deps chromium
TARGET_URL="https://www.currys.co.uk/..." EXPECTED_SKU="..." npm run fetch:one
```

Run a target list:

```bash
TARGETS_FILE=config/targets.json npm run fetch:batch
```

## Accuracy rules

An observation is marked `accepted: true` only when:

1. the page is not identified as blocked;
2. the expected SKU/EAN, when supplied, is found on the rendered page or in structured product data; and
3. a plausible GBP price is extracted.

Generic extraction is deliberately conservative. Retailer-specific extractors should be added before treating this as a complete production pricing system.

## Public-repository safety

The workflows that can access Supabase secrets run only from the default repository workflow through `schedule`, `workflow_dispatch`, or owner-authored issues. No workflow with secrets runs untrusted pull-request code. Standard GitHub-hosted runners are used; larger runners are not configured.
