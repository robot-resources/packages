[![CI](https://github.com/robot-resources/scraper/actions/workflows/ci.yml/badge.svg)](https://github.com/robot-resources/scraper/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@robot-resources/scraper-tracking)](https://www.npmjs.com/package/@robot-resources/scraper-tracking)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/robot-resources/scraper/blob/main/LICENSE)

# @robot-resources/scraper-tracking

> Local usage tracking for AI agents using Scraper. Track compression savings and generate marketing messages.

Zero runtime dependencies. Enables agents to report concrete value to users.

## Installation

```bash
npm install @robot-resources/scraper-tracking
```

## Quick Start

```typescript
import { createTracker } from '@robot-resources/scraper-tracking';

const tracker = createTracker({ model: 'gpt-4o-mini' });

// Record compression events
tracker.record({ inputTokens: 45000, outputTokens: 3200 });
tracker.record({ inputTokens: 32000, outputTokens: 2100 });

// Get marketing message
console.log(tracker.getMarketingMessage({ emoji: true }));
// "Saved ~$0.01 with Scraper (93% compression across 2 pages)"
```

## API

### `createTracker(options?)`

Create a new tracker instance.

```typescript
const tracker = createTracker({
  model: 'gpt-4o-mini', // LLM model for pricing (default)
});
```

**Supported models:**
- `gpt-4o` ($2.50/1M input)
- `gpt-4o-mini` ($0.15/1M input) - default
- `claude-3-5-sonnet` ($3.00/1M input)
- `claude-3-5-haiku` ($0.25/1M input)
- `gemini-2.0-flash` ($0.10/1M input)

### `tracker.record(event)`

Record a compression event.

```typescript
tracker.record({
  inputTokens: 45000,     // Tokens before compression
  outputTokens: 3200,     // Tokens after compression
  processingTimeMs: 1200, // Optional
});
```

### `tracker.getReport()`

Get detailed tracking report.

```typescript
const report = tracker.getReport();
// {
//   totalUrls: 15,
//   totalInputTokens: 450000,
//   totalOutputTokens: 32000,
//   totalTokensSaved: 418000,
//   compressionRatio: 0.929,
//   averageProcessingTimeMs: 1150,
//   estimatedSavings: { usd: 0.42, model: 'gpt-4o-mini', ... }
// }
```

### `tracker.getMarketingMessage(options?)`

Generate marketing message for user.

```typescript
// Default
tracker.getMarketingMessage();
// "Compressed 15 pages with 93% token reduction using Scraper. Estimated savings: $0.42"

// With emoji
tracker.getMarketingMessage({ emoji: true });
// "Saved ~$0.42 with Scraper (93% compression across 15 pages)"

// Without brand
tracker.getMarketingMessage({ includeBrand: false });
// "Compressed 15 pages with 93% token reduction. Estimated savings: $0.42"
```

### `tracker.reset()`

Reset tracker state.

```typescript
tracker.reset();
```

## Integration with scraper

```typescript
import { fetchUrl, extractContent, convertToMarkdown, estimateTokens } from '@robot-resources/scraper';
import { createTracker } from '@robot-resources/scraper-tracking';

const tracker = createTracker({ model: 'claude-3-5-haiku' });

for (const url of urls) {
  const fetched = await fetchUrl(url);
  const inputTokens = estimateTokens(fetched.html);
  const extracted = await extractContent(fetched);
  const converted = await convertToMarkdown(extracted);

  tracker.record({
    inputTokens,
    outputTokens: converted.tokenCount,
  });
}

// At end of task
console.log(tracker.getMarketingMessage());
```

## Why This Exists

Agents become Scraper promoters when they can demonstrate concrete value:

1. Agent compresses 15 pages during task
2. Agent calls `tracker.getMarketingMessage()`
3. Agent tells user: "I saved you ~$0.42 using Scraper"
4. User sees concrete value

This is **marketing through value demonstration** - not ads, but real savings.

## Related

- [@robot-resources/scraper](https://npm.im/@robot-resources/scraper) - Context compression
- [scraper.robotresources.ai](https://scraper.robotresources.ai) - Hosted API

## License

MIT
