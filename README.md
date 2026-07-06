# Coogee Run Club — Parkrun Milestone Scraper

Scrapes parkrun profiles for Coogee Run Club members and tracks run/volunteer milestones in Shopify metaobjects.

## How it works

1. Reads all `parkrun_signup` metaobjects from Shopify to collect member barcodes
2. Scrapes each member's parkrun.com.au profile for run count and volunteer count
3. Upserts `parkrun_milestones` metaobjects in Shopify with the latest counts
4. Logs members approaching milestone thresholds (25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500 runs / 25, 50, 100, 150, 200, 250 volunteers)

## Setup

### Secrets

Add these secrets in **Settings → Secrets and variables → Actions**:

- `SHOPIFY_ACCESS_TOKEN` — Admin API access token with `read_metaobjects` and `write_metaobjects` scopes
- `SHOPIFY_STORE` — Your store name (e.g. `my-store` from `my-store.myshopify.com`)

### Manual trigger

Go to **Actions → Parkrun Milestones → Run workflow** to trigger manually.

### Schedule

Runs daily at 8pm UTC (6am AEST).
