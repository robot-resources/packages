/**
 * Layer 2: Extract
 * Content extraction using Readability
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { FetchResult, ExtractResult } from './types.js';

/**
 * Error class for extraction-related errors
 */
export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/**
 * Extract main content from HTML using Readability
 */
export async function extractContent(
  fetchResult: FetchResult
): Promise<ExtractResult> {
  const { html } = fetchResult;

  if (!html || !html.trim()) {
    throw new ExtractionError('Empty HTML content', 'EMPTY_HTML');
  }

  const { document } = parseHTML(html);

  const reader = new Readability(document, {
    charThreshold: 50,
  });

  const article = reader.parse();

  if (!article || !article.content || article.content.trim().length < 20) {
    throw new ExtractionError(
      'No content could be extracted from the page',
      'NO_CONTENT'
    );
  }

  const result: ExtractResult = {
    content: cleanContent(article.content),
    title: article.title || extractFallbackTitle(document),
    author: article.byline || undefined,
    publishedAt: article.publishedTime || extractPublishedTime(document),
    siteName: article.siteName || extractSiteName(document),
  };

  return result;
}

function cleanContent(content: string): string {
  return content
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractFallbackTitle(document: Document): string | undefined {
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const content = ogTitle.getAttribute('content');
    if (content) return content;
  }

  const titleEl = document.querySelector('title');
  if (titleEl && titleEl.textContent) {
    return titleEl.textContent.trim();
  }

  const h1 = document.querySelector('h1');
  if (h1 && h1.textContent) {
    return h1.textContent.trim();
  }

  return undefined;
}

function extractPublishedTime(document: Document): string | undefined {
  const ogTime = document.querySelector(
    'meta[property="article:published_time"]'
  );
  if (ogTime) {
    const content = ogTime.getAttribute('content');
    if (content) return content;
  }

  const schemaTime = document.querySelector('[itemprop="datePublished"]');
  if (schemaTime) {
    const datetime = schemaTime.getAttribute('datetime');
    if (datetime) return datetime;
    const content = schemaTime.getAttribute('content');
    if (content) return content;
  }

  const timeEl = document.querySelector('time[datetime]');
  if (timeEl) {
    const datetime = timeEl.getAttribute('datetime');
    if (datetime) return datetime;
  }

  return undefined;
}

function extractSiteName(document: Document): string | undefined {
  const ogSiteName = document.querySelector('meta[property="og:site_name"]');
  if (ogSiteName) {
    const content = ogSiteName.getAttribute('content');
    if (content) return content;
  }

  const appName = document.querySelector('meta[name="application-name"]');
  if (appName) {
    const content = appName.getAttribute('content');
    if (content) return content;
  }

  return undefined;
}
