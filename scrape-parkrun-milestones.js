const https = require('https');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'coogee-run-club';
const GRAPHQL_URL = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2026-07/graphql.json`;

const CLUB_PAGE_URL = 'https://www.parkrun.com.au/centennial/groups/47764/';

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
            fields { key value }
          }
          cursor
        }
        pageInfo { hasNextPage }
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

async function fetchClubMembers(browser) {
  const members = new Map();
  const page = await browser.newPage();
  try {
    await page.goto(CLUB_PAGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000);
    const html = await page.content();
    if (html.includes('Human Verification') || html.includes('awsWafCookieDomainList')) {
      console.log('Club page blocked by WAF even with Puppeteer - skipping club member import');
      await page.close();
      return members;
    }
    const extracted = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('table a[href*="/parkrunner/"]').forEach(el => {
        const href = el.getAttribute('href');
        const match = href.match(/\/parkrunner\/(\d+)/);
        if (match) {
          const barcode = 'A' + match[1];
          const rawName = el.textContent.trim();
          const name = rawName.split(' ').map(w =>
            w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
          ).join(' ');
          results.push({ barcode, name });
        }
      });
      return results;
    });
    for (const { barcode, name } of extracted) {
      members.set(barcode, name);
    }
    console.log(`Found ${members.size} members from club page`);
  } catch (err) {
    console.log(`Club page fetch error: ${err.message} - skipping club member import`);
  }
  await page.close();
  return members;
}
async function scrapeMember(browser, barcode, memberNum, total) {
  const numericBarcode = barcode.replace(/^A/i, '');
  const profileUrl = `https://www.parkrun.com.au/parkrunner/${numericBarcode}/all/`;
  const page = await browser.newPage();
  try {
    await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2000);
    const html = await page.content();
    if (html.includes('Human Verification') || html.includes('awsWafCookieDomainList')) {
      if (memberNum <= 3) console.log(`  WAF blocked on Puppeteer for ${barcode}`);
      await page.close();
      return { runCount: 0, volunteerCount: 0, lastRunDate: null, blocked: true };
    }
    const data = await page.evaluate(() => {
      let runCount = 0;
      let volunteerCount = 0;
      let lastRunDate = null;
      document.querySelectorAll('h3').forEach(el => {
        const text = el.textContent;
        const match = text.match(/(\d+)\s*parkruns?\s*total/i);
        if (match) runCount = parseInt(match[1], 10);
      });
      if (runCount === 0) {
        const h2 = document.querySelector('#content h2');
        if (h2) {
          const match = h2.textContent.match(/(\d+)\s*parkruns?/i);
          if (match) runCount = parseInt(match[1], 10);
        }
      }
      document.querySelectorAll('td').forEach(el => {
        const text = el.textContent.trim();
        if (text === 'Total Credits' || text.includes('Total Credits')) {
          const next = el.nextElementSibling;
          if (next) {
            volunteerCount = parseInt(next.textContent.trim(), 10) || 0;
          }
        }
      });
      if (volunteerCount === 0) {
        const volTable = document.querySelector('#volunteer-summary');
        if (volTable) {
          const table = volTable.nextElementSibling;
          if (table && table.tagName === 'TABLE') {
            table.querySelectorAll('tfoot td').forEach(el => {
              const val = parseInt(el.textContent.trim(), 10);
              if (val > 0) volunteerCount = val;
            });
          }
        }
      }
      const resultsTable = document.querySelector('table#results');
      if (resultsTable) {
        const headers = [];
        resultsTable.querySelectorAll('th').forEach(el => headers.push(el.textContent.trim()));
        const dateColIndex = headers.findIndex(h => /run\s*date/i.test(h));
        if (dateColIndex >= 0) {
          const firstRow = resultsTable.querySelector('tbody tr');
          if (firstRow) {
            const cells = [];
            firstRow.querySelectorAll('td').forEach(el => cells.push(el.textContent.trim()));
            const dateStr = cells[dateColIndex];
            if (dateStr) {
              const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
              if (match) lastRunDate = `${match[3]}-${match[2]}-${match[1]}`;
            }
          }
        }
      }
      return { runCount, volunteerCount, lastRunDate };
    });
    await page.close();
    return { ...data, blocked: false };
  } catch (err) {
    console.log(`  Error scraping ${barcode}: ${err.message}`);
    await page.close();
    return { runCount: 0, volunteerCount: 0, lastRunDate: null, blocked: true };
  }
}
async function upsertMilestone(barcode, name, runCount, volunteerCount, lastRunDate) {
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
  if (lastRunDate) {
    fields.push({ key: "last_run_date", value: lastRunDate });
  }
  if (existing.metaobjectByHandle) {
    const mutation = `mutation UpdateMilestone($id: ID!, $fields: [MetaobjectFieldInput!]!) {
      metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
        metaobject { handle }
        userErrors { field message }
      }
    }`;
    const result = await graphqlRequest(mutation, { id: existing.metaobjectByHandle.id, fields });
    const errors = result.metaobjectUpdate?.userErrors || [];
    if (errors.length > 0) console.error(`  Update errors for ${barcode}:`, JSON.stringify(errors));
    else console.log(`  Updated milestone for ${barcode}`);
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
    if (errors.length > 0) console.error(`  Create errors for ${barcode}:`, JSON.stringify(errors));
    else console.log(`  Created milestone for ${barcode}`);
  }
}
function getApproachingMilestones(name, barcode, runCount, volunteerCount) {
  const alerts = [];
  for (const m of RUN_MILESTONES) {
    const diff = m - runCount;
    if (diff > 0 && diff <= 5) alerts.push(`${name} (${barcode}): ${diff} run(s) away from ${m} milestone`);
  }
  for (const m of VOLUNTEER_MILESTONES) {
    const diff = m - volunteerCount;
    if (diff > 0 && diff <= 5) alerts.push(`${name} (${barcode}): ${diff} volunteer(s) away from ${m} milestone`);
  }
  return alerts;
}

async function main() {
  console.log('=== Parkrun Milestone Scraper (Puppeteer) ===');
  console.log(`Store: ${SHOPIFY_STORE} | Token: ${SHOPIFY_ACCESS_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const signups = await fetchAllSignups();

  console.log('\nLaunching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
  });
  console.log('Browser launched');

  console.log('\nFetching club page members...');
  const clubMembers = await fetchClubMembers(browser);
  let newFromClub = 0;
  for (const [barcode, name] of clubMembers) {
    if (!signups.has(barcode)) {
      signups.set(barcode, name);
      newFromClub++;
    }
  }
  console.log(`Added ${newFromClub} new members from club page (total: ${signups.size})\n`);
  const alerts = [];
  let memberCount = 0;
  let blockedCount = 0;
  let updatedCount = 0;
  let consecutiveBlocked = 0;
  const BATCH_SIZE = 30;
  const BATCH_COOLDOWN = 60000;
  for (const [barcode, name] of signups) {
    memberCount++;
    if (memberCount > 1 && (memberCount - 1) % BATCH_SIZE === 0) {
      console.log(`  --- Batch cooldown (60s) after ${memberCount - 1} members ---`);
      await sleep(BATCH_COOLDOWN);
      consecutiveBlocked = 0;
    }
    if (consecutiveBlocked >= 10) {
      console.log(`  --- Extra cooldown (120s) after ${consecutiveBlocked} consecutive blocks ---`);
      await sleep(120000);
      consecutiveBlocked = 0;
    }
    console.log(`Scraping ${name || barcode}... (${memberCount}/${signups.size})`);
    let { runCount, volunteerCount, lastRunDate, blocked } = await scrapeMember(browser, barcode, memberCount, signups.size);
    if (blocked) {
      console.log(`  Blocked - waiting 45s and retrying...`);
      await sleep(45000);
      ({ runCount, volunteerCount, lastRunDate, blocked } = await scrapeMember(browser, barcode, memberCount, signups.size));
    }
    console.log(`  Runs: ${runCount}, Volunteers: ${volunteerCount}, Last Run: ${lastRunDate || 'N/A'}${blocked ? ' (BLOCKED - skipping upsert)' : ''}`);
    if (!blocked) {
      if (runCount === 0 && volunteerCount === 0) {
        console.log(`  Both counts are 0 - likely parsing failure, skipping upsert to protect existing data`);
      } else {
        await upsertMilestone(barcode, name, runCount, volunteerCount, lastRunDate);
        alerts.push(...getApproachingMilestones(name, barcode, runCount, volunteerCount));
        updatedCount++;
      }
      consecutiveBlocked = 0;
    } else {
      blockedCount++;
      consecutiveBlocked++;
    }
    const delay = 3000 + Math.floor(Math.random() * 2000);
    await sleep(delay);
  }
  await browser.close();
  console.log(`\nProcessed: ${memberCount} members, ${updatedCount} updated, ${blockedCount} blocked`);
  console.log('\n=== Approaching Milestones ===');
  if (alerts.length === 0) console.log('No members approaching milestones.');
  else for (const a of alerts) console.log(` \u{1F3C3} ${a}`);
  console.log(`\nCompleted: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
