#!/usr/bin/env npx ts-node
/**
 * MFC Field Audit Script
 *
 * Scrapes N MFC figure pages and captures the .data-field structures
 * for analysis. Produces a JSONL log and a summary report.
 *
 * Usage:
 *   # With explicit IDs
 *   npx ts-node scripts/audit-mfc-fields.ts --ids 12345,67890
 *
 *   # From a file of IDs (one per line)
 *   npx ts-node scripts/audit-mfc-fields.ts --file mfc-ids.txt --limit 100
 *
 *   # Pull IDs from production database
 *   npx ts-node scripts/audit-mfc-fields.ts --from-db --limit 150
 *
 * Environment variables:
 *   MONGODB_URI      - MongoDB connection string (required for --from-db)
 *   MFC_COOKIES      - JSON object of MFC auth cookies for NSFW/authenticated access
 *                      e.g. '{"PHPSESSID":"abc","sesUID":"123","sesDID":"456","cf_clearance":"xyz"}'
 *
 * Output:
 *   logs/field-audit.jsonl   - One JSON object per figure
 *   stdout                   - Summary report with label frequencies
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { auditMfcFields, appendFieldAuditLog, type IFieldAuditResult } from '../src/services/fieldAuditCollector';

// Parse CLI args
const args = process.argv.slice(2);
let limit = 100;
let skip = 0;
let specificIds: number[] = [];
let idsFile = '';
let fromDb = false;
let delayMs = 2000;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) {
    limit = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--skip' && args[i + 1]) {
    skip = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--ids' && args[i + 1]) {
    specificIds = args[i + 1].split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
    i++;
  } else if (args[i] === '--file' && args[i + 1]) {
    idsFile = args[i + 1];
    i++;
  } else if (args[i] === '--from-db') {
    fromDb = true;
  } else if (args[i] === '--delay' && args[i + 1]) {
    delayMs = parseInt(args[i + 1], 10);
    i++;
  }
}

/**
 * Parse MFC cookies from MFC_COOKIES env var.
 * Returns a formatted Cookie header string, or undefined if not set.
 */
function getMfcCookieHeader(): string | undefined {
  const cookieEnv = process.env.MFC_COOKIES;
  if (!cookieEnv) return undefined;

  try {
    const cookies: Record<string, string> = JSON.parse(cookieEnv);
    const parts = Object.entries(cookies)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${v}`);
    if (parts.length === 0) return undefined;
    return parts.join('; ');
  } catch {
    console.warn('[AUDIT] Failed to parse MFC_COOKIES env var as JSON, ignoring');
    return undefined;
  }
}

/**
 * Fetch MFC IDs from the production database using the native MongoDB driver.
 * Queries the figures collection for all distinct mfcId values.
 */
async function fetchMfcIdsFromDb(maxIds: number, skipCount: number): Promise<number[]> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI environment variable is required for --from-db');
    process.exit(1);
  }

  // Dynamic import to avoid requiring mongodb for non-DB modes
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('[AUDIT] Connected to MongoDB');

    // Determine database name from URI or default
    const dbName = uri.includes('/') ? uri.split('/').pop()?.split('?')[0] : undefined;
    const db = dbName ? client.db(dbName) : client.db();

    const figures = db.collection('figures');
    const docs = await figures
      .find({ mfcId: { $exists: true, $ne: null } }, { projection: { mfcId: 1 } })
      .skip(skipCount)
      .limit(maxIds)
      .toArray();

    const ids = docs
      .map(doc => doc.mfcId as number)
      .filter(id => typeof id === 'number' && !isNaN(id));

    console.log(`[AUDIT] Found ${ids.length} figures with MFC IDs in database (skip: ${skipCount})`);
    return ids;
  } finally {
    await client.close();
  }
}

function fetchHtml(url: string, cookieHeader?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    };
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    https.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect, carry cookies forward
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://myfigurecollection.net${res.headers.location}`;
        fetchHtml(redirectUrl, cookieHeader).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const cookieHeader = getMfcCookieHeader();
  if (cookieHeader) {
    console.log('[AUDIT] MFC cookies loaded from MFC_COOKIES env var');
  } else {
    console.log('[AUDIT] No MFC cookies set — NSFW/restricted pages may not load fully');
    console.log('[AUDIT] Set MFC_COOKIES env var with JSON cookie object for authenticated access');
  }

  // Determine which MFC IDs to audit
  let mfcIds: number[] = [];

  if (specificIds.length > 0) {
    mfcIds = specificIds;
  } else if (idsFile) {
    const content = fs.readFileSync(idsFile, 'utf-8');
    mfcIds = content.split('\n')
      .map(line => parseInt(line.trim(), 10))
      .filter(id => !isNaN(id));
  } else if (fromDb) {
    mfcIds = await fetchMfcIdsFromDb(limit, skip);
  } else {
    console.log('No IDs specified. Use one of:');
    console.log('  --ids 12345,67890           Explicit comma-separated IDs');
    console.log('  --file mfc-ids.txt          File with one ID per line');
    console.log('  --from-db                   Pull from production database (needs MONGODB_URI)');
    console.log('');
    console.log('Options:');
    console.log('  --limit N                   Max figures to audit (default: 100)');
    console.log('  --skip N                    Skip first N figures from DB (default: 0)');
    console.log('  --delay N                   Delay between requests in ms (default: 2000)');
    console.log('');
    console.log('Environment:');
    console.log('  MONGODB_URI                 MongoDB connection string (for --from-db)');
    console.log('  MFC_COOKIES                 JSON cookie object for authenticated MFC access');
    process.exit(1);
  }

  mfcIds = mfcIds.slice(0, limit);
  console.log(`\nAuditing ${mfcIds.length} MFC items (delay: ${delayMs}ms)...\n`);

  // Ensure logs directory exists
  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const logFile = path.join(logsDir, 'field-audit.jsonl');
  const results: IFieldAuditResult[] = [];
  const labelCounts: Record<string, number> = {};
  const unknownLabelCounts: Record<string, number> = {};
  // Track grouped entry role variations across all figures
  const roleVariations: Record<string, Set<string>> = {};
  let successCount = 0;
  let failCount = 0;

  for (const mfcId of mfcIds) {
    try {
      const url = `https://myfigurecollection.net/item/${mfcId}`;
      process.stdout.write(`  [${successCount + failCount + 1}/${mfcIds.length}] MFC #${mfcId}...`);
      const html = await fetchHtml(url, cookieHeader);

      const auditResult = auditMfcFields(html, mfcId);
      results.push(auditResult);

      // Append to JSONL log
      const jsonlLine = appendFieldAuditLog(auditResult);
      fs.appendFileSync(logFile, jsonlLine + '\n');

      // Aggregate label counts
      for (const field of auditResult.fields) {
        labelCounts[field.label] = (labelCounts[field.label] || 0) + 1;

        // Track role sub-element variations for grouped entries
        if (field.hasRoleSubElements && field.roleTexts && field.roleTexts.length > 0) {
          for (const roleText of field.roleTexts) {
            if (!roleVariations[field.label]) {
              roleVariations[field.label] = new Set();
            }
            roleVariations[field.label].add(roleText);
          }
        }
      }
      for (const label of auditResult.unknownLabels) {
        unknownLabelCounts[label] = (unknownLabelCounts[label] || 0) + 1;
      }

      successCount++;
      console.log(` OK (${auditResult.fields.length} fields${auditResult.unknownLabels.length > 0 ? `, ${auditResult.unknownLabels.length} unknown` : ''})`);

      // Rate limit
      if (successCount + failCount < mfcIds.length) {
        await sleep(delayMs);
      }
    } catch (error: any) {
      console.log(` FAIL: ${error.message}`);
      failCount++;
    }
  }

  // Print summary report
  console.log('\n' + '='.repeat(60));
  console.log('FIELD AUDIT SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total: ${successCount} succeeded, ${failCount} failed`);
  console.log(`Log file: ${logFile}`);

  console.log('\n--- Known Label Frequencies ---');
  const sortedLabels = Object.entries(labelCounts).sort((a, b) => b[1] - a[1]);
  for (const [label, count] of sortedLabels) {
    const pct = ((count / successCount) * 100).toFixed(0);
    console.log(`  ${label}: ${count} (${pct}%)`);
  }

  if (Object.keys(roleVariations).length > 0) {
    console.log('\n--- Role Sub-Element Variations (in grouped entries) ---');
    for (const [label, roles] of Object.entries(roleVariations)) {
      console.log(`  ${label}: ${Array.from(roles).sort().join(', ')}`);
    }
  }

  if (Object.keys(unknownLabelCounts).length > 0) {
    console.log('\n--- UNKNOWN Labels (not in registry) ---');
    const sortedUnknown = Object.entries(unknownLabelCounts).sort((a, b) => b[1] - a[1]);
    for (const [label, count] of sortedUnknown) {
      console.log(`  WARNING: "${label}": ${count}`);
    }
    console.log('\n  >> Add these to mfcLabelRegistry.ts to suppress warnings');
  } else {
    console.log('\n--- All labels recognized by registry ---');
  }
}

main().catch(error => {
  console.error('Audit failed:', error);
  process.exit(1);
});
