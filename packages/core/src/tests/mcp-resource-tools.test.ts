import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../agent/agent.js';

test('MCP resource local tools delegate to the active MCP client facade', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-mcp-resources-'));
  const calls: Array<{ method: string; args: any }> = [];
  const mcp: any = {
    async listTools() { return { tools: [] }; },
    async callTool() { return { isError: false, content: [] }; },
    async listResources(args: any) {
      calls.push({ method: 'listResources', args });
      return { resources: [{ server: 'github', uri: 'repo://issues', name: 'Issues' }] };
    },
    async listResourceTemplates(args: any) {
      calls.push({ method: 'listResourceTemplates', args });
      return { resourceTemplates: [{ server: 'github', uriTemplate: 'repo://{owner}/{repo}', name: 'Repository' }] };
    },
    async readResource(args: any) {
      calls.push({ method: 'readResource', args });
      return { server: args.server, contents: [{ uri: args.uri, text: 'open issues' }] };
    },
  };
  const agent: any = new Agent(mcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
    workspaceRoot: workspace,
    launchCwd: workspace,
    silent: true,
  });

  const resources = JSON.parse(await agent.executeLocalTool('list_mcp_resources', { server: 'github', cursor: 'c1' }));
  const templates = JSON.parse(await agent.executeLocalTool('list_mcp_resource_templates', { server: 'github' }));
  const read = JSON.parse(await agent.executeLocalTool('read_mcp_resource', { server: 'github', uri: 'repo://issues' }));

  assert.equal(resources.resources[0].uri, 'repo://issues');
  assert.equal(templates.resourceTemplates[0].uriTemplate, 'repo://{owner}/{repo}');
  assert.equal(read.contents[0].text, 'open issues');
  assert.deepEqual(calls.map((c) => c.method), ['listResources', 'listResourceTemplates', 'readResource']);
  assert.deepEqual(calls[0].args, { server: 'github', cursor: 'c1' });
  assert.deepEqual(calls[2].args, { server: 'github', uri: 'repo://issues' });
});
