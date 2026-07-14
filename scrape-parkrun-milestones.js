const https = require('https');
const cheerio = require('cheerio');

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'coogee-run-club';
const GRAPHQL_URL = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2025-10/graphql.json`;
const REST_URL = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2025-10`;

const RUN_MILESTONES = [25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
const VOLUNTEER_MILESTONES = [25, 50, 100, 150, 200, 250];

const PARKRUN_URLS = [
  (id) => `https://www.parkrun.org.uk/parkrunner/${id}/`,
  (id) => `https://www.parkrun.co.nz/parkrunner/${id}/`,
  (id) => `https://www.parkrun.us/parkrunner/${id}/`,
  (id) => `https://www.parkrun.co.za/parkrunner/${id}/`,
  (id) => `https://www.parkrun.com.au/parkrunner/${id}/`,
  (id) => `https://www.parkrun.org.uk/results/athleteresultshistory/?athleteNumber=${id}`,
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
      },
      rejectUnauthorized: false,
    };

    https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          redirectUrl = `https://${urlObj.hostname}${redirectUrl}`;
        }
        httpGet(redirectUrl).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    }).on('error', reject);
  });
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

function parseRunCount($) {
  let runCount = 0;
  const heading = $('#content h2').first().text();
  if (heading) {
    const match = heading.match(/(\d+)\s*parkruns?/i);
    if (match) runCount = parseInt(match[1], 10);
  }
  if (runCount === 0) {
    $('h3').each((i, el) => {
      const text = $(el).text();
      const match = text.match(/(\d+)\s*parkruns?\s*total/i);
      if (match) runCount = parseInt(match[1], 10);
    });
  }
  return runCount;
}

function parseVolunteerCount($) {
  let volunteerCount = 0;
  $('#volunteer-summary').next().find('tbody > tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 3) {
      volunteerCount += parseInt($(cells[2]).text().trim(), 10) || 0;
    }
  });
  if (volunteerCount === 0) {
    $('td').each((i, el) => {
      const text = $(el).text().trim();
      if (text === 'Total Credits' || text.includes('Total Credits')) {
        const next = $(el).next();
        if (next.length) {
          volunteerCount = parseInt(next.text().trim(), 10) || 0;
        }
      }
    });
  }
  return volunteerCount;
}

let workingUrlIndex = -1;

async function scrapeMember(barcode, isFirst) {
  const numericBarcode = barcode.replace(/^A/i, '');

  const urlsToTry = workingUrlIndex >= 0
    ? [PARKRUN_URLS[workingUrlIndex]]
    : PARKRUN_URLS;

  for (let i = 0; i < urlsToTry.length; i++) {
    const urlFn = urlsToTry[i];
    const url = urlFn(numericBarcode);

    try {
      const { statusCode, body } = await httpGet(url);

      if (isFirst) {
        const titleMatch = body.match(/<title>(.*?)<\/title>/i);
        console.log(`  TRY ${url}`);
        console.log(`    status=${statusCode} len=${body.length} title="${titleMatch ? titleMatch[1] : 'none'}"`);
      }

      if (body.includes('Human Verification') || body.includes('awsWafCookieDomainList')) {
        if (isFirst) console.log(`    WAF blocked`);
        continue;
      }

      const $ = cheerio.load(body);
      const runCount = parseRunCount($);
      const volunteerCount = parseVolunteerCount($);

      if (workingUrlIndex < 0) {
        const realIndex = PARKRUN_URLS.indexOf(urlFn);
        workingUrlIndex = realIndex;
        console.log(`  Found working URL pattern: ${url}`);
      }
      return { runCount, volunteerCount, blocked: false };

    } catch (err) {
      if (isFirst) console.log(`    Error: ${err.message}`);
    }
  }

  return { runCount: 0, volunteerCount: 0, blocked: true };
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

  const signups = await fetchAllSignups();
  const alerts = [];
  let isFirst = true;

  for (const [barcode, name] of signups) {
    console.log(`Scraping ${name || barcode}...`);
    const { runCount, volunteerCount, blocked } = await scrapeMember(barcode, isFirst);
    isFirst = false;
    console.log(`  Runs: ${runCount}, Volunteers: ${volunteerCount}${blocked ? ' (BLOCKED - skipping upsert)' : ''}`);

    if (!blocked) {
      await upsertMilestone(barcode, name, runCount, volunteerCount);
      alerts.push(...getApproachingMilestones(name, barcode, runCount, volunteerCount));
    }

    await sleep(1000);
  }

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
