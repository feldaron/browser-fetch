import { chromium } from "playwright";

const rawUrl = process.argv[2] ?? "https://www.currys.co.uk/";
const startUrl = new URL(rawUrl);
if (!['http:', 'https:'].includes(startUrl.protocol)) {
  throw new Error('The private browser start URL must use http or https.');
}

const context = await chromium.launchPersistentContext('/tmp/private-browser-profile', {
  headless: false,
  viewport: null,
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-infobars',
    '--start-maximized',
    '--window-size=1600,1000',
  ],
});

const pages = context.pages();
const page = pages[0] ?? (await context.newPage());
await page.goto(startUrl.toString(), {
  waitUntil: 'domcontentloaded',
  timeout: 45_000,
}).catch((error) => {
  console.error(`Initial navigation failed: ${error instanceof Error ? error.message : String(error)}`);
});

console.log(`Private browser opened at ${startUrl.toString()}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await context.close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
await new Promise(() => undefined);
