#!/usr/bin/env npx tsx
/**
 * Comparative Benchmark: scraper vs naive alternatives
 *
 * Compares three approaches:
 *   (a) Raw HTML — token count of the full HTML
 *   (b) Naive strip-tags — regex tag removal + whitespace collapse
 *   (c) Scraper pipeline — Readability + Turndown + cleanup
 *
 * Uses existing benchmark fixtures (inline HTML), no network needed.
 *
 * Run: npm run benchmark (from scraper package)
 */

import { allFixtures } from '../../api/test/fixtures/benchmark/index.js';
import { extractContent } from '../src/extract.js';
import { convertToMarkdown, estimateTokens } from '../src/convert.js';

// ── Approach (b): Naive strip-tags ──────────────────────────

function naiveStripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Run benchmark ───────────────────────────────────────────

interface BenchmarkRow {
  id: string;
  type: string;
  rawHtmlTokens: number;
  naiveTokens: number;
  naiveReduction: number;
  scraperTokens: number;
  scraperReduction: number;
  scraperVsNaiveAdvantage: number;
  mustContainRate: number;
}

async function runBenchmark(): Promise<void> {
  const rows: BenchmarkRow[] = [];

  for (const fixture of allFixtures) {
    const rawHtmlTokens = estimateTokens(fixture.html);

    // (b) Naive
    const naiveText = naiveStripTags(fixture.html);
    const naiveTokens = estimateTokens(naiveText);
    const naiveReduction = rawHtmlTokens > 0 ? 1 - naiveTokens / rawHtmlTokens : 0;

    // (c) Scraper pipeline
    try {
      const fetchResult = {
        html: fixture.html,
        url: `https://example.com/${fixture.id}`,
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
      };

      const extracted = await extractContent(fetchResult);
      const converted = await convertToMarkdown(extracted);
      const scraperTokens = converted.tokenCount;
      const scraperReduction = rawHtmlTokens > 0 ? 1 - scraperTokens / rawHtmlTokens : 0;

      // Content preservation for scraper
      const lower = converted.markdown.toLowerCase();
      const found = fixture.expected.mustContain.filter((p) =>
        lower.includes(p.toLowerCase())
      );
      const mustContainRate = fixture.expected.mustContain.length > 0
        ? found.length / fixture.expected.mustContain.length
        : 1;

      rows.push({
        id: fixture.id,
        type: fixture.type,
        rawHtmlTokens,
        naiveTokens,
        naiveReduction,
        scraperTokens,
        scraperReduction,
        scraperVsNaiveAdvantage: (scraperReduction - naiveReduction) * 100,
        mustContainRate,
      });
    } catch (err) {
      console.error(`  SKIP ${fixture.id}: ${err}`);
    }
  }

  if (rows.length === 0) {
    console.error('No fixtures processed.');
    process.exit(1);
  }

  // ── Print results ───────────────────────────────────────

  console.log(
    '\n' +
    '=========================================================\n' +
    '  COMPARATIVE BENCHMARK: scraper vs naive strip-tags\n' +
    '=========================================================\n'
  );

  const cols = {
    id: 22,
    type: 12,
    raw: 10,
    naive: 10,
    scraper: 10,
    naivePct: 10,
    scraperPct: 12,
    adv: 12,
    content: 10,
  };

  console.log(
    'Fixture'.padEnd(cols.id) +
    'Type'.padEnd(cols.type) +
    'Raw HTML'.padEnd(cols.raw) +
    'Naive'.padEnd(cols.naive) +
    'Scraper'.padEnd(cols.scraper) +
    'Naive %'.padEnd(cols.naivePct) +
    'Scraper %'.padEnd(cols.scraperPct) +
    'Advantage'.padEnd(cols.adv) +
    'Content %'
  );
  console.log('-'.repeat(108));

  for (const r of rows) {
    console.log(
      r.id.padEnd(cols.id) +
      r.type.padEnd(cols.type) +
      String(r.rawHtmlTokens).padEnd(cols.raw) +
      String(r.naiveTokens).padEnd(cols.naive) +
      String(r.scraperTokens).padEnd(cols.scraper) +
      `${(r.naiveReduction * 100).toFixed(0)}%`.padEnd(cols.naivePct) +
      `${(r.scraperReduction * 100).toFixed(0)}%`.padEnd(cols.scraperPct) +
      `+${r.scraperVsNaiveAdvantage.toFixed(0)}pp`.padEnd(cols.adv) +
      `${(r.mustContainRate * 100).toFixed(0)}%`
    );
  }

  // Averages
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const avgNaive = avg(rows.map((r) => r.naiveReduction));
  const avgScraper = avg(rows.map((r) => r.scraperReduction));
  const avgAdvantage = avg(rows.map((r) => r.scraperVsNaiveAdvantage));
  const avgContent = avg(rows.map((r) => r.mustContainRate));

  console.log('-'.repeat(108));
  console.log(
    'AVERAGE'.padEnd(cols.id + cols.type + cols.raw + cols.naive + cols.scraper) +
    `${(avgNaive * 100).toFixed(0)}%`.padEnd(cols.naivePct) +
    `${(avgScraper * 100).toFixed(0)}%`.padEnd(cols.scraperPct) +
    `+${avgAdvantage.toFixed(0)}pp`.padEnd(cols.adv) +
    `${(avgContent * 100).toFixed(0)}%`
  );

  console.log(
    '\n-- KEY INSIGHT --\n' +
    `Scraper achieves ${(avgScraper * 100).toFixed(0)}% average token reduction ` +
    `vs naive strip-tags at ${(avgNaive * 100).toFixed(0)}%.\n` +
    `That's +${avgAdvantage.toFixed(0)} percentage points better, ` +
    `while preserving ${(avgContent * 100).toFixed(0)}% of key content.\n`
  );
}

runBenchmark().catch(console.error);
