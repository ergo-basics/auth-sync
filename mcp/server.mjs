#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS } from './tools.mjs';

const server = new McpServer({ name: 'auth-sync', version: '0.1.0' });
for (const [name, t] of Object.entries(TOOLS)) {
  server.tool(name, t.description, t.schema, async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await t.handler(args), null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] };
    }
  });
}
await server.connect(new StdioServerTransport());
