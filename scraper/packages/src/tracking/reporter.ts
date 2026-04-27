/**
 * Reporter - Generate marketing messages
 */

import type { TrackingReport, MarketingMessageOptions } from './types.js';

/**
 * Format USD amount
 */
function formatUSD(amount: number): string {
  if (amount < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}

/**
 * Format compression ratio as percentage
 */
function formatRatio(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * Generate marketing message from tracking report
 */
export function generateMarketingMessage(
  report: TrackingReport,
  options: MarketingMessageOptions = {}
): string {
  const { emoji = false, includeBrand = true } = options;

  const { totalUrls, compressionRatio, estimatedSavings } = report;

  // Handle edge cases
  if (totalUrls === 0) {
    return emoji ? '📊 No pages compressed yet' : 'No pages compressed yet';
  }

  const pages = totalUrls === 1 ? '1 page' : `${totalUrls} pages`;
  const ratio = formatRatio(compressionRatio);
  const savings = formatUSD(estimatedSavings.usd);

  // Build message
  if (emoji) {
    if (includeBrand) {
      return `💰 Saved ~${savings} with Scraper (${ratio} compression across ${pages})`;
    }
    return `💰 Saved ~${savings} (${ratio} compression across ${pages})`;
  }

  if (includeBrand) {
    return `Compressed ${pages} with ${ratio} token reduction using Scraper. Estimated savings: ${savings}`;
  }

  return `Compressed ${pages} with ${ratio} token reduction. Estimated savings: ${savings}`;
}

/**
 * Generate short summary message
 */
export function generateShortMessage(report: TrackingReport): string {
  if (report.totalUrls === 0) return 'No data';

  const savings = formatUSD(report.estimatedSavings.usd);
  const ratio = formatRatio(report.compressionRatio);

  return `${ratio} reduction, ~${savings} saved`;
}
