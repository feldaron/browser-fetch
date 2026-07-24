# browser-fetch

Fresh, isolated Chromium price observations and an on-demand private Chrome desktop for LaptopValue, using standard GitHub-hosted Ubuntu runners.

## What it does

- Opens each product in a fresh browser context with UK locale and Europe/London timezone.
- Extracts price candidates from Product JSON-LD, price metadata and visible price elements.
- Checks an expected SKU and/or EAN before accepting the observation.
- Records the final URL, HTTP status, product identifiers, availability and a screenshot.
- Writes JSON evidence to a GitHub Actions artifact.
- Optionally inserts the same observation into Supabase.
- Rejects URLs outside an explicit retailer-domain allowlist.
- Provides a temporary interactive Chrome desktop at `privatebrowser.laptopvalue.co.uk` through Cloudflare Tunnel and Access.
- Does not attempt to bypass CAPTCHAs or retailer access controls.

A new browser context is created for every automated product check. Batch jobs reuse the Chromium process while keeping cookies, cache and local storage isolated between products.

## Automated price fetching

### From ChatGPT through an owner issue

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

Only an issue opened by the repository owner is allowed to start the job. The workflow posts the structured result back as an issue comment and closes the issue.

### Manually

Open **Actions → Fetch one product price → Run workflow** and enter a product URL plus its exact SKU and/or EAN.

### Daily batch

Add targets to `config/targets.json`. The scheduled workflow runs daily at 05:17 UTC and divides the list across four standard Ubuntu jobs.

## Interactive private browser

The **Private browser session** workflow starts a fresh headed Chromium desktop and makes it available at:

`https://privatebrowser.laptopvalue.co.uk`

The interface uses noVNC locally and a remotely managed Cloudflare Tunnel. Cloudflare Access must restrict the hostname to the intended user before the tunnel token is configured.

A session can be started manually from GitHub Actions or by creating an owner-authored issue titled `[browser]` with this JSON body:

```json
{
  "startUrl": "https://www.currys.co.uk/",
  "durationMinutes": 60
}
```

Sessions last between 15 and 300 minutes. Starting a new one cancels the previous session. All browser state is destroyed with the runner.

See [`docs/private-browser-setup.md`](docs/private-browser-setup.md) for the Cloudflare Tunnel, Access and GitHub secret setup.

## Supabase setup

Run `supabase/001_browser_price_observations.sql` in the Supabase SQL editor, then add these repository secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional repository variables:

- `SUPABASE_TABLE` — defaults to `browser_price_observations`
- `ALLOWED_HOSTS` — comma-separated additional approved domains

The service-role key must only be stored as a GitHub Actions secret. Never put it in source code, an issue, a workflow input or `config/targets.json`.

The private desktop additionally requires:

- `CLOUDFLARE_TUNNEL_TOKEN`

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

Workflows that can access secrets run only from the default repository workflow through `schedule`, `workflow_dispatch`, or owner-authored issues. No workflow with secrets runs untrusted pull-request code. Standard GitHub-hosted runners are used; larger runners are not configured.
