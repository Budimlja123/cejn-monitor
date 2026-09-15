// One-time discovery: open the public CEJN tenders page in headless Edge,
// capture every /api/ request (method, URL, POST body) and a snippet of the
// JSON response so we can learn the public tender-search endpoint + payload.
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TARGET = 'https://cejn.gov.me/tenders';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  const apiCalls = [];

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/')) {
      apiCalls.push({
        method: req.method(),
        url,
        postData: req.postData() || null,
      });
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/') && res.request().method() !== 'OPTIONS') {
      let snippet = '';
      try {
        const t = await res.text();
        snippet = t.slice(0, 600);
      } catch (e) {
        snippet = '<no body>';
      }
      const call = apiCalls.find((c) => c.url === url && !c.responseSnippet);
      if (call) {
        call.status = res.status();
        call.responseSnippet = snippet;
      }
    }
  });

  await page.goto(TARGET, { waitUntil: 'networkidle2', timeout: 60000 });
  // give lazy chunks / grid a moment
  await new Promise((r) => setTimeout(r, 4000));

  console.log('===== API CALLS ON /tenders =====');
  for (const c of apiCalls) {
    console.log('\n--- ' + c.method + ' ' + c.url + '  [' + (c.status || '?') + ']');
    if (c.postData) console.log('  POST BODY: ' + c.postData);
    if (c.responseSnippet) console.log('  RESP: ' + c.responseSnippet.replace(/\s+/g, ' ').slice(0, 400));
  }

  await browser.close();
})().catch((e) => {
  console.error('DISCOVERY ERROR:', e.message);
  process.exit(1);
});
