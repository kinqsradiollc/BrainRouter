#!/usr/bin/env node

// Process-level bootstrap (warning filtering + crash diagnostics + optional
// debugExit tracing). Imported FIRST so its top-level side effects run before
// any command is registered or parsed — matching the original ordering where
// these handlers were installed at the very top of the entrypoint.
import './entry/bootstrap.js';

import { Command } from 'commander';
import { VERSION } from '@kinqs/brainrouter-core/version';
import { registerChatCommand } from './entry/chatCommand.js';
import { registerRunCommand } from './entry/runCommand.js';
import { registerLoginCommand, registerConfigCommand } from './entry/authConfigCommands.js';
import { registerGithubCommand } from './entry/githubCommand.js';
import { registerAgentsCommand } from './entry/agentsCommand.js';
import { registerFleetCommand } from './entry/fleetCommand.js';
import { registerPluginCommand } from './entry/pluginCommand.js';
import { registerMarketplaceCommand } from './entry/marketplaceCommand.js';
import { registerServeCommand } from './entry/serveCommand.js';
import { registerAutomationsCommand } from './entry/automationsCommand.js';
import { registerTasksCommand } from './entry/tasksCommand.js';
import { registerConversationsCommand } from './entry/conversationsCommand.js';
import { registerChatSyncCommand } from './entry/chatSyncCommand.js';
import { registerRunnerCommand } from './entry/runnerCommand.js';
import { registerAgentHookCommand } from './entry/agentHookCommand.js';
import { registerMcpProxyCommand } from './entry/mcpProxyCommand.js';

const program = new Command();

program
  .name('brainrouter')
  .description('BrainRouter CLI — Premium interactive terminal-based agent client.')
  .version(VERSION);

registerChatCommand(program);
registerRunCommand(program);
registerLoginCommand(program);
registerConfigCommand(program);
registerGithubCommand(program);
registerAgentsCommand(program);
registerFleetCommand(program);
registerPluginCommand(program);
registerMarketplaceCommand(program);
registerServeCommand(program);
registerAutomationsCommand(program);
registerTasksCommand(program);
registerConversationsCommand(program);
registerChatSyncCommand(program);
registerRunnerCommand(program);
registerAgentHookCommand(program);
registerMcpProxyCommand(program);

program.parse(process.argv);
