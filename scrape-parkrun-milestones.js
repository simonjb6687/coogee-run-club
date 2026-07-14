const https = require('https');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'coogee-run-club';
const GRAPHQL_URL = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2025-10/graphql.json`;
const REST_URL = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2025-10`;

const RUN_MILESTONES = [25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
const VOLUNTEER_MILESTONES = [25, 50, 100, 150, 200, 250];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function graphqlRequest(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const url = new URL(GRAPHQL_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'User-Agent': 'CoogeeRunClub/1.0',
        'Accept': 'application/json',
      },
      rejectUnauthorized: false,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) console.log('DEBUG - Response status:', res.statusCode);
        if (res.statusCode !== 200) {
          reject(new Error(`Shopify returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.errors) reject(new Error(JSON.stringify(json.errors)));
          else resolve(json.data);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function fetchAllSignups() {
  const barcodes = new Map();
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      metaobjects(type: "parkrun_signup", first: 50${afterClause}) {
        edges {
          node {
            handle
            fields {
              key
              value
            }
          }
          cursor
        }
        pageInfo {
          hasNextPage
        }
      }
    }`;

    const data = await graphqlRequest(query);
    const edges = data.metaobjects.edges;

    for (const edge of edges) {
      const fields = {};
      for (const f of edge.node.fields) fields[f.key] = f.value;
      const barcode = fields.barcode || fields.parkrun_barcode;
      const name = fields.name || fields.member_name || fields.first_name || '';
      if (barcode) barcodes.set(barcode, name);
      cursor = edge.cursor;
    }

    hasNext = data.metaobjects.pageInfo.hasNextPage;
  }

  console.log(`Found ${barcodes.size} unique barcodes from parkrun_signup metaobjects`);
  return barcodes;
}

async function scrapeMember(page, barcode, isFirst) {
  const numericBarcode = barcode.replace(/^A/i, '');
  const url = `https://www.parkrun.com.au/parkrunner/${numericBarcode}/`;
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    try {
      await page.waitForFunction(
        () => document.title !== 'Human Verification' && document.querySelector('h3'),
        { timeout: 30000 }
      );
    } catch {
      if (isFirst) console.log(`  DEBUG: page title after wait = "${await page.title()}"`);
    }

    if (isFirst) {
      const title = await page.title();
      console.log(`  DEBUG page title: ${title}`);
      const h3Count = await page.$$eval('h3', els => els.length);
      console.log(`  DEBUG h3 count: ${h3Count}`);
      const h3Texts = await page.$$eval('h3', els => els.map(e => e.textContent.trim()).slice(0, 5));
      console.log(`  DEBUG h3 texts: ${JSON.stringify(h3Texts)}`);
    }

    const result = await page.evaluate(() => {
      let runCount = 0;
      let volunteerCount = 0;

      const h3s = document.querySelectorAll('h3');
      for (const h3 of h3s) {
        const match = h3.textContent.match(/(\d+)\s*parkruns?\s*total/i);
        if (match) runCount = parseInt(match[1], 10);
      }

      const tds = document.querySelectorAll('td');
      for (let i = 0; i < tds.length; i++) {
        if (tds[i].textContent.trim() === 'Total Credits' && tds[i + 1]) {
          volunteerCount = parseInt(tds[i + 1].textContent.trim(), 10) || 0;
        }
      }

      return { runCount, volunteerCount };
    });

    return result;
  } catch (err) {
    console.error(`  Error scraping ${barcode}: ${err.message}`);
    return { runCount: 0, volunteerCount: 0 };
  }
}

async function upsertMilestone(barcode, name, runCount, volunteerCount) {
  const handle = `milestone-${barcode.toLowerCase()}`;
  const now = new Date().toISOString().split('T')[0];

  const checkQuery = `{
    metaobjectByHandle(handle: { type: "parkrun_milestones", handle: "${handle}" }) {
      id
    }
  }`;

  const existing = await graphqlRequest(checkQuery);

  const fields = [
    { key: "member_name", value: name },
    { key: "parkrun_barcode", value: barcode },
    { key: "run_count", value: String(runCount) },
    { key: "volunteer_count", value: String(volunteerCount) },
    { key: "last_updated", value: now },
  ];

  if (existing.metaobjectByHandle) {
    const mutation = `mutation UpdateMilestone($id: ID!, $fields: [MetaobjectFieldInput!]!) {
      metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
        metaobject { handle }
        userErrors { field message }
      }
    }`;
    const result = await graphqlRequest(mutation, { id: existing.metaobjectByHandle.id, fields });
    const errors = result.metaobjectUpdate?.userErrors || [];
    if (errors.length > 0) {
      console.error(`  Update errors for ${barcode}:`, JSON.stringify(errors));
    } else {
      console.log(`  Updated milestone for ${barcode}`);
    }
  } else {
    const mutation = `mutation CreateMilestone($handle: String!, $fields: [MetaobjectFieldInput!]!) {
      metaobjectCreate(metaobject: {
        type: "parkrun_milestones",
        handle: $handle,
        fields: $fields
      }) {
        metaobject { handle }
        userErrors { field message }
      }
    }`;
    const result = await graphqlRequest(mutation, { handle, fields });
    const errors = result.metaobjectCreate?.userErrors || [];
    if (errors.length > 0) {
      console.error(`  Create errors for ${barcode}:`, JSON.stringify(errors));
    } else {
      console.log(`  Created milestone for ${barcode}`);
    }
  }
}

function getApproachingMilestones(name, barcode, runCount, volunteerCount) {
  const alerts = [];
  for (const m of RUN_MILESTONES) {
    const diff = m - runCount;
    if (diff > 0 && diff <= 5) {
      alerts.push(`${name} (${barcode}): ${diff} run(s) away from ${m} milestone`);
    }
  }
  for (const m of VOLUNTEER_MILESTONES) {
    const diff = m - volunteerCount;
    if (diff > 0 && diff <= 5) {
      alerts.push(`${name} (${barcode}): ${diff} volunteer(s) away from ${m} milestone`);
    }
  }
  return alerts;
}

async function main() {
  console.log('=== Parkrun Milestone Scraper ===');
  console.log(`Store: ${SHOPIFY_STORE} | Token: ${SHOPIFY_ACCESS_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  console.log('Browser launched');

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  const signups = await fetchAllSignups();
  const alerts = [];
  let isFirst = true;

  for (const [barcode, name] of signups) {
    console.log(`Scraping ${name || barcode}...`);
    const { runCount, volunteerCount } = await scrapeMember(page, barcode, isFirst);
    isFirst = false;
    console.log(`  Runs: ${runCount}, Volunteers: ${volunteerCount}`);

    await upsertMilestone(barcode, name, runCount, volunteerCount);
    alerts.push(...getApproachingMilestones(name, barcode, runCount, volunteerCount));

    await sleep(1000);
  }

  await browser.close();

  console.log('\n=== Approaching Milestones ===');
  if (alerts.length === 0) {
    console.log('No members approaching milestones.');
  } else {
    for (const a of alerts) console.log(`  \u{1F3C3} ${a}`);
  }

  console.log(`\nCompleted: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
