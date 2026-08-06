const https = require('https');

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'coogee-run-club';
const GRAPHQL_URL = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2026-07/graphql.json`;

const PARKRUN_API = 'api.parkrun.com';
const PARKRUN_CLIENT_ID = 'netdreams-iphone-s01';
const PARKRUN_CLIENT_SECRET = 'gfKbDD6NJkYoFmkisR(iVFopQCKWzbQeQgZAZZKK';
const PARKRUN_USER = process.env.PARKRUN_ATHLETE_ID;
const PARKRUN_PASS = process.env.PARKRUN_PASSWORD;

const RUN_MILESTONES = [25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
const VOLUNTEER_MILESTONES = [25, 50, 100, 150, 200, 250];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function parkrunAuth() {
  if (!PARKRUN_USER || !PARKRUN_PASS) {
    throw new Error('PARKRUN_ATHLETE_ID and PARKRUN_PASSWORD env vars required');
  }
  const body = `username=${encodeURIComponent(PARKRUN_USER)}&password=${encodeURIComponent(PARKRUN_PASS)}&scope=app&grant_type=password`;
  const auth = Buffer.from(`${PARKRUN_CLIENT_ID}:${PARKRUN_CLIENT_SECRET}`).toString('base64');
  const res = await httpsRequest({
    hostname: PARKRUN_API,
    path: '/user_auth.php',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
      'User-Agent': 'parkrun/1.2.7 CFNetwork/1121.2.2 Darwin/19.3.0',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (!res.access_token) throw new Error('Auth failed: ' + JSON.stringify(res).substring(0, 200));
  console.log('Authenticated with parkrun API');
  return res.access_token;
}

function parkrunGet(path, token, params) {
  const qs = new URLSearchParams({
    expandedDetails: 'true',
    access_token: token,
    scope: 'app',
    ...params,
  }).toString();
  return httpsRequest({
    hostname: PARKRUN_API,
    path: `${path}?${qs}`,
    method: 'GET',
    headers: {
      'User-Agent': 'parkrun/1.2.7 CFNetwork/1121.2.2 Darwin/19.3.0',
      'Accept': 'application/json',
    },
  });
}

async function getRunCount(token, athleteId) {
  try {
    const res = await parkrunGet('/v1/hasrun/count/Run', token, {
      athleteId: String(athleteId),
      offset: '0',
    });
    return parseInt(res?.data?.TotalRuns?.[0]?.RunTotal, 10) || 0;
  } catch (e) {
    console.log(`  Run count failed for ${athleteId}: ${e.message}`);
    return 0;
  }
}

async function getVolunteerCount(token, athleteId) {
  try {
    const res = await parkrunGet('/v1/hasrun/count/Volunteer', token, {
      athleteId: String(athleteId),
      offset: '0',
    });
    if (res?.data?.TotalVolunteers?.[0]?.VolunteerTotal) {
      return parseInt(res.data.TotalVolunteers[0].VolunteerTotal, 10) || 0;
    }
    if (res?.data?.TotalRuns?.[0]?.RunTotal) {
      return parseInt(res.data.TotalRuns[0].RunTotal, 10) || 0;
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

async function getLastRunDate(token, athleteId) {
  try {
    const res = await parkrunGet('/v1/results', token, {
      athleteId: String(athleteId),
      limit: '1',
      offset: '0',
    });
    const result = res?.data?.Results?.[0];
    if (!result) return null;
    const raw = result.EventDate;
    if (!raw) return null;
    const match = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    const match2 = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (match2) return `${match2[3]}-${match2[2]}-${match2[1]}`;
    return raw.substring(0, 10);
  } catch (e) {
    return null;
  }
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
        if (res.statusCode !== 200) {
          reject(new Error(`Shopify returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.errors) reject(new Error(JSON.stringify(json.errors)));
          else resolve(json.data);
        } catch (e) { reject(e); }
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
          node { handle fields { key value } }
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

async function upsertMilestone(barcode, name, runCount, volunteerCount, lastRunDate) {
  const handle = `milestone-${barcode.toLowerCase()}`;
  const now = new Date().toISOString().split('T')[0];
  const checkQuery = `{
    metaobjectByHandle(handle: { type: "parkrun_milestones", handle: "${handle}" }) { id }
  }`;
  const existing = await graphqlRequest(checkQuery);
  const fields = [
    { key: 'member_name', value: name },
    { key: 'parkrun_barcode', value: barcode },
    { key: 'run_count', value: String(runCount) },
    { key: 'volunteer_count', value: String(volunteerCount) },
    { key: 'last_updated', value: now },
  ];
  if (lastRunDate) fields.push({ key: 'last_run_date', value: lastRunDate });

  if (existing.metaobjectByHandle) {
    const mutation = `mutation UpdateMilestone($id: ID!, $fields: [MetaobjectFieldInput!]!) {
      metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
        metaobject { handle } userErrors { field message }
      }
    }`;
    const result = await graphqlRequest(mutation, { id: existing.metaobjectByHandle.id, fields });
    const errors = result.metaobjectUpdate?.userErrors || [];
    if (errors.length > 0) console.error(`  Update errors for ${barcode}:`, JSON.stringify(errors));
  } else {
    const mutation = `mutation CreateMilestone($handle: String!, $fields: [MetaobjectFieldInput!]!) {
      metaobjectCreate(metaobject: { type: "parkrun_milestones", handle: $handle, fields: $fields }) {
        metaobject { handle } userErrors { field message }
      }
    }`;
    const result = await graphqlRequest(mutation, { handle, fields });
    const errors = result.metaobjectCreate?.userErrors || [];
    if (errors.length > 0) console.error(`  Create errors for ${barcode}:`, JSON.stringify(errors));
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
  console.log('=== Parkrun Milestone Scraper (API Version) ===');
  console.log(`Store: ${SHOPIFY_STORE} | Shopify Token: ${SHOPIFY_ACCESS_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`parkrun User: ${PARKRUN_USER || 'MISSING'}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const token = await parkrunAuth();
  const signups = await fetchAllSignups();

  const alerts = [];
  let memberCount = 0;
  let updatedCount = 0;
  let failedCount = 0;
  let volunteerEndpointWorks = null;

  for (const [barcode, name] of signups) {
    memberCount++;
    const numericId = barcode.replace(/^A/i, '');

    if (memberCount > 1) await sleep(500);

    console.log(`[${memberCount}/${signups.size}] ${name || barcode}...`);

    const runCount = await getRunCount(token, numericId);

    let volunteerCount = 0;
    if (volunteerEndpointWorks !== false) {
      volunteerCount = await getVolunteerCount(token, numericId);
      if (memberCount === 1 && volunteerCount === 0) {
        console.log('  Note: volunteer endpoint returned 0, will continue trying for other members');
      }
      if (volunteerCount > 0 && volunteerEndpointWorks === null) {
        volunteerEndpointWorks = true;
        console.log('  Volunteer count endpoint confirmed working');
      }
    }

    let lastRunDate = null;
    if (runCount > 0) {
      lastRunDate = await getLastRunDate(token, numericId);
    }

    console.log(`  Runs: ${runCount}, Volunteers: ${volunteerCount}, Last Run: ${lastRunDate || 'N/A'}`);

    if (runCount === 0 && volunteerCount === 0) {
      console.log('  Both counts 0 — skipping upsert to protect existing data');
      failedCount++;
      continue;
    }

    try {
      await upsertMilestone(barcode, name, runCount, volunteerCount, lastRunDate);
      alerts.push(...getApproachingMilestones(name, barcode, runCount, volunteerCount));
      updatedCount++;
    } catch (e) {
      console.error(`  Upsert failed for ${barcode}: ${e.message}`);
      failedCount++;
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Processed: ${memberCount} | Updated: ${updatedCount} | Skipped/Failed: ${failedCount}`);
  if (volunteerEndpointWorks === null) {
    console.log('Note: Volunteer count endpoint was not confirmed working. Counts may be 0.');
  }

  console.log('\n=== Approaching Milestones ===');
  if (alerts.length === 0) console.log('No members approaching milestones.');
  else for (const a of alerts) console.log(`  ${a}`);

  console.log(`\nCompleted: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
