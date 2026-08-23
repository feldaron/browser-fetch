# browser-fetch

Public, generic browser-fetching and verification code for the LaptopValue UK laptop-pricing project. It uses Playwright with **Google Chrome** on standard `ubuntu-latest` GitHub-hosted runners. It does not use Vercel and does not contain Supabase credentials, private database exports or internal valuation logic.

## Safety boundary

The workflows only visit an explicit retailer hostname allowlist. They do not attempt to bypass CAPTCHAs, Cloudflare challenges, access controls or retailer anti-bot protections. A blocked page is recorded as `blocked` and quarantined.

Fetching is deliberately separate from database writing:

1. Chrome produces compact JSON evidence.
2. Evidence is reviewed or passes strict validation.
3. A controlled importer outside this public repository writes eligible observations to Supabase.

**Encrypted GitHub Actions secrets required for the current fetch workflows: none.**

No Supabase URL, service-role key or database token should be added to this repository. If direct importing is added later, it must be a separate, disabled-by-default workflow and would require exactly `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as encrypted Actions secrets.

## Modes

### `specific-product`

Loads one product page in repeated isolated Chrome contexts and verifies:

- requested, final and canonical URLs;
- HTTP status and literal retailer item number;
- product title, manufacturer, family, MPN/SKU and EAN/GTIN;
- CPU, GPU, RAM, storage, display and colour when present;
- main purchase-block price, delivery charge, effective price and currency;
- availability and in-stock state;
- JSON-LD/structured-offer price;
- identity and price conflicts, evidence URLs, provenance and timestamp.

The main visible purchase price is mandatory. JSON-LD is a cross-check, not a substitute. A visible/structured disagreement is a `conflict`, never an eligible observation.

### `catalogue-discovery`

Loads catalogue pages and records the literal product-card `href` values. Catalogue-card prices are ignored.

### `controlled-crawl`

Discovers literal product URLs page by page, then verifies each individual product page. A checkpoint JSON file is rewritten after discovery and after each product, so a partial artifact shows exactly where the run stopped. Resume by starting a new run at the first incomplete catalogue page.

## Statuses

- `success` — evidence agrees and identity is strong enough.
- `conflict` — identity, price or repeated-load evidence disagrees.
- `blocked` — retailer protection or an access block was encountered.
- `failed` — navigation or required evidence could not be obtained.

Only `success` results with `eligible: true` may enter a controlled import step. Screenshots and HTML are saved only for conflicts, blocks, failures or an explicitly disputed product.

## GitHub Actions

Open **Actions → Browser fetch and verify → Run workflow**. The workflow accepts retailer, mode, catalogue URL, start/end page, optional product URL, exact identifiers, expected price, repeat count and headed/headless selection.

Concurrency controls prevent overlapping runs of the same retailer/mode. Standard runners are used; chargeable larger runners are not configured. There is no scheduled crawl, which avoids unnecessary GitHub Actions minutes.

### Owner issue request

An owner-authored issue can start the same verifier. The title must begin `[browser-fetch]` and the body must be JSON. This is useful for controlled automation without exposing secrets.

Protected Currys verification example:

```json
{
  "mode": "specific-product",
  "retailer": "currys",
  "productUrl": "https://www.currys.co.uk/products/acer-swift-16-ai-16-laptop-copilot-pc-intel-core-ultra-x7-1-tb-ssd-grey-10296598.html",
  "expectedItemNumber": "10296598",
  "expectedMpn": "NX.JU1EK.001",
  "expectedEan": "4711474906946",
  "expectedPrice": 1799,
  "repeatCount": 6,
  "headed": true
}
```

Currys page-6 crawl example:

```json
{
  "mode": "controlled-crawl",
  "retailer": "currys",
  "catalogueUrl": "https://www.currys.co.uk/computing/laptops/laptops/windows-laptops?searchTerm=laptop",
  "startPage": 6,
  "endPage": 6,
  "pageSize": 20,
  "repeatCount": 2,
  "headed": true
}
```

## Local validation

```bash
npm install --ignore-scripts
npm run check
npm test
```

For a live Chrome check, install Google Chrome and run under a desktop or Xvfb:

```bash
MODE=specific-product \
PRODUCT_URL='https://www.currys.co.uk/products/example-10200000.html' \
EXPECTED_ITEM_NUMBER=10200000 \
HEADED=true \
xvfb-run -a npm run browser-fetch
```

## Currys pagination

Currys page numbers are translated to `start=(page-1)*pageSize` and `sz=pageSize`. With 20 products per page, page 6 uses `start=100&sz=20`.

## Protected correction

Currys item `10296598` is the Acer Swift 16 AI, MPN `NX.JU1EK.001`, EAN `4711474906946`. The known robust correction is **£1,799**, not £1,599. The included fixture and tests protect that identity and price expectation; a live run still has to verify the current retailer page before any new observation is imported.

## Private interactive browser

Open **Actions → Private browser session → Run workflow** to start a temporary
interactive desktop at `privatebrowser.laptopvalue.co.uk`. Firefox is the default;
Chrome remains available as a workflow choice. The selected browser is launched
directly as a normal desktop process rather than through Playwright, so the manual
session does not show Chrome's test-software banner or inherit Playwright's
automation launch flags.

Owner-authored `[browser]` issues can select the browser with a JSON `browser`
property (`"firefox"` or `"chrome"`). Firefox is used when the property is omitted.

Files downloaded in either browser are saved under
`/tmp/private-browser/downloads`. The workflow includes that directory in its
`private-browser-logs-<run-id>` artifact, so downloads remain retrievable after
the temporary browser session ends.
