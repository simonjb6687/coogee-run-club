const https = require('https');
const cheerio = require('cheerio');

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'coogee-run-club';
const GRAPHQL_URL = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2025-10/graphql.json`;

const CLUB_PAGE_URL = 'https://www.parkrun.com.au/centennial/groups/47764/';

const RUN_MILESTONES = [25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
const VOLUNTEER_MILESTONES = [25, 50, 100, 150, 200, 250];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-AU,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'identity',
      'Cache-Control': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
    redirect: 'follow',
  });
  const body = await res.text();
  return { statusCode: res.status, body };
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

async function fetchClubMembers() {
  const members = new Map();
  try {
    const { statusCode, body } = await fetchPage(CLUB_PAGE_URL);
    if (body.includes('Human Verification') || body.includes('awsWafCookieDomainList')) {
      console.log('Club page blocked by WAF - skipping club member import');
      return members;
    }
    if (statusCode !== 200) {
      console.log(`Club page returned HTTP ${statusCode} - skipping club member import`);
      return members;
    }
    const $ = cheerio.load(body);
    $('table a[href*="/parkrunner/"]').each((_, el) => {
      const href = $(el).attr('href');
      const match = href.match(/\/parkrunner\/(\d+)/);
      if (match) {
        const barcode = `A${match[1]}`;
        const rawName = $(el).text().trim();
        const name = rawName.split(' ').map(w =>
          w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        ).join(' ');
        members.set(barcode, name);
      }
    });
    console.log(`Found ${members.size} members from club page`);
  } catch (err) {
    console.log(`Club page fetch error: ${err.message} - skipping club member import`);
  }
  return members;
}

function parseRunCount($) {
  let runCount = 0;
  $('h3').each((_, el) => {
    const text = $(el).text();
    const match = text.match(/(\d+)\s*parkruns?\s*total/i);
    if (match) runCount = parseInt(match[1], 10);
  });
  if (runCount === 0) {
    const heading = $('#content h2').first().text();
    if (heading) {
      const match = heading.match(/(\d+)\s*parkruns?/i);
      if (match) runCount = parseInt(match[1], 10);
    }
  }
  return runCount;
}

function parseVolunteerCount($) {
  let volunteerCount = 0;
  $('td').each((_, el) => {
    const text = $(el).text().trim();
    if (text === 'Total Credits' || text.includes('Total Credits')) {
      const next = $(el).next();
      if (next.length) {
        volunteerCount = parseInt(next.text().trim(), 10) || 0;
      }
    }
  });
  if (volunteerCount === 0) {
    const volTable = $('#volunteer-summary').next('table');
    if (volTable.length) {
      volTable.find('tfoot td').each((_, el) => {
        const val = parseInt($(el).text().trim(), 10);
        if (val > 0) volunteerCount = val;
      });
    }
  }
  return volunteerCount;
}

function parseLastRunDate($) {
  const tables = $('table#results');
  if (tables.length === 0) return null;
  const firstTable = tables.first();
  const headers = [];
  firstTable.find('th').each((_, el) => headers.push($(el).text().trim()));
  const dateColIndex = headers.findIndex(h => /run\s*date/i.test(h));
  if (dateColIndex < 0) return null;
  const firstRow = firstTable.find('tbody tr').first();
  if (!firstRow.length) return null;
  const cells = [];
  firstRow.find('td').each((_, el) => cells.push($(el).text().trim()));
  const dateStr = cells[dateColIndex];
  if (!dateStr) return null;
  const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

let workingApproach = -1;

async function scrapeMember(barcode, isFirst) {
  const numericBarcode = barcode.replace(/^A/i, '');
  const profileUrl = `https://www.parkrun.com.au/parkrunner/${numericBarcode}/`;

  const approaches = [
    { label: 'proxy', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(profileUrl)}` },
    { label: 'direct-au', url: profileUrl },
    { label: 'direct-uk', url: `https://www.parkrun.org.uk/parkrunner/${numericBarcode}/` },
  ];

  const toTry = workingApproach >= 0 ? [approaches[workingApproach]] : approaches;

  for (let i = 0; i < toTry.length; i++) {
    const { label, url } = toTry[i];
    try {
      const { statusCode, body } = await fetchPage(url);
      if (isFirst) {
        const titleMatch = body.match(/<title>(.*?)<\/title>/i);
        console.log(`  [${label}] ${url.substring(0, 100)}`);
        console.log(`    status=${statusCode} len=${body.length} title="${titleMatch ? titleMatch[1] : 'none'}"`);
      }
      if (body.includes('Human Verification') || body.includes('awsWafCookieDomainList')) {
        if (isFirst) console.log(`    WAF blocked`);
        continue;
      }
      if (statusCode !== 200) {
        if (isFirst) console.log(`    Non-200 status`);
        continue;
      }
      const $ = cheerio.load(body);
      const runCount = parseRunCount($);
      const volunteerCount = parseVolunteerCount($);
      const lastRunDate = parseLastRunDate($);
      if (workingApproach < 0) {
        workingApproach = approaches.indexOf(toTry[i]);
        console.log(`  Working approach: ${label}`);
      }
      return { runCount, volunteerCount, lastRunDate, blocked: false };
    } catch (err) {
      if (isFirst) console.log(`  [${label}] Error: ${err.message}`);
    }
  }
  return { runCount: 0, volunteerCount: 0, lastRunDate: null, blocked: true };
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
  console.log('=== Parkrun Milestone Scraper ===');
  console.log(`Store: ${SHOPIFY_STORE} | Token: ${SHOPIFY_ACCESS_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const signups = await fetchAllSignups();

  console.log('\nFetching club page members...');
  const clubMembers = await fetchClubMembers();
  let newFromClub = 0;
  for (const [barcode, name] of clubMembers) {
    if (!signups.has(barcode)) {
      signups.set(barcode, name);
      newFromClub++;
    }
  }
  console.log(`Added ${newFromClub} new members from club page (total: ${signups.size})\n`);

  const alerts = [];
  let isFirst = true;
  let memberCount = 0;
  let blockedCount = 0;
  let consecutiveBlocked = 0;
  const BATCH_SIZE = 30;
  const BATCH_COOLDOWN = 60000;
  for (const [barcode, name] of signups) {
    memberCount++;
    if (memberCount > 1 && (memberCount - 1) % BATCH_SIZE === 0) {
      console.log(`  --- Batch cooldown (60s) after ${memberCount - 1} members ---`);
      await sleep(BATCH_COOLDOWN);
      workingApproach = -1;
      consecutiveBlocked = 0;
    }
    if (consecutiveBlocked >= 5) {
      console.log(`  --- Extra cooldown (90s) after ${consecutiveBlocked} consecutive blocks ---`);
      await sleep(90000);
      workingApproach = -1;
      consecutiveBlocked = 0;
    }
    console.log(`Scraping ${name || barcode}... (${memberCount}/${signups.size})`);
    let { runCount, volunteerCount, lastRunDate, blocked } = await scrapeMember(barcode, isFirst);
    isFirst = false;
    if (blocked) {
      console.log(`  Blocked - waiting 30s and retrying...`);
      await sleep(30000);
      workingApproach = -1;
      ({ runCount, volunteerCount, lastRunDate, blocked } = await scrapeMember(barcode, false));
    }
    console.log(`  Runs: ${runCount}, Volunteers: ${volunteerCount}, Last Run: ${lastRunDate || 'N/A'}${blocked ? ' (BLOCKED - skipping upsert)' : ''}`);
    if (!blocked) {
      await upsertMilestone(barcode, name, runCount, volunteerCount, lastRunDate);
      alerts.push(...getApproachingMilestones(name, barcode, runCount, volunteerCount));
      consecutiveBlocked = 0;
    } else {
      blockedCount++;
      consecutiveBlocked++;
    }
    const delay = 3000 + Math.floor(Math.random() * 2000);
    await sleep(delay);
  }
  console.log(`\nProcessed: ${memberCount} members, ${blockedCount} blocked`);
  console.log('\n=== Approaching Milestones ===');
  if (alerts.length === 0) console.log('No members approaching milestones.');
  else for (const a of alerts) console.log(`  🏃 ${a}`);
  console.log(`\nCompleted: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
