/**
 * MCP server entry point
 * Starts the scraper MCP server with stdio transport
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './mcp-server.js';
import { flushTelemetry } from './telemetry.js';

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

// Flush pending telemetry before process exits (fire-and-forget → await on exit)
process.on('beforeExit', async () => {
  await flushTelemetry();
});
