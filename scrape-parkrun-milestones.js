const https = require('https');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
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
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'User-Agent': 'CoogeeRunClub/1.0',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CoogeeRunClub/1.0' }, rejectUnauthorized: false }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
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

function parseParkrunProfile(html) {
  let runCount = 0;
  let volunteerCount = 0;

  const runMatch = html.match(/<h3[^>]*>\s*(\d+)\s*parkruns?\s*total/i);
  if (runMatch) runCount = parseInt(runMatch[1], 10);

  const volMatch = html.match(/Total\s+Credits[\s\S]*?<td[^>]*>\s*(\d+)\s*<\/td>/i);
  if (volMatch) volunteerCount = parseInt(volMatch[1], 10);

  return { runCount, volunteerCount };
}

async function scrapeMember(barcode) {
  const numericBarcode = barcode.replace(/^A/i, '');
  const url = `https://www.parkrun.com.au/parkrunner/${numericBarcode}/`;
  try {
    const html = await httpGet(url);
    return parseParkrunProfile(html);
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
    { key: "member_name", value: JSON.stringify(name) },
    { key: "parkrun_barcode", value: JSON.stringify(barcode) },
    { key: "run_count", value: JSON.stringify(runCount) },
    { key: "volunteer_count", value: JSON.stringify(volunteerCount) },
    { key: "last_updated", value: JSON.stringify(now) },
  ];

  if (existing.metaobjectByHandle) {
    const mutation = `mutation UpdateMilestone($id: ID!, $fields: [MetaobjectFieldInput!]!) {
      metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
        metaobject { handle }
        userErrors { field message }
      }
    }`;
    await graphqlRequest(mutation, { id: existing.metaobjectByHandle.id, fields });
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
    await graphqlRequest(mutation, { handle, fields });
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
  console.log(`Started: ${new Date().toISOString()}\n`);

  const signups = await fetchAllSignups();
  const alerts = [];

  for (const [barcode, name] of signups) {
    console.log(`Scraping ${name || barcode}...`);
    const { runCount, volunteerCount } = await scrapeMember(barcode);
    console.log(`  Runs: ${runCount}, Volunteers: ${volunteerCount}`);

    await upsertMilestone(barcode, name, runCount, volunteerCount);
    alerts.push(...getApproachingMilestones(name, barcode, runCount, volunteerCount));

    await sleep(2000);
  }

  console.log('\n=== Approaching Milestones ===');
  if (alerts.length === 0) {
    console.log('No members approaching milestones.');
  } else {
    for (const a of alerts) console.log(`  ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ ${a}`);
  }

  console.log(`\nCompleted: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
