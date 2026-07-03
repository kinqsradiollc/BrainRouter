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
import { registerAgentsCommand } from './entry/agentsCommand.js';
import { registerFleetCommand } from './entry/fleetCommand.js';
import { registerPluginCommand } from './entry/pluginCommand.js';

const program = new Command();

program
  .name('brainrouter')
  .description('BrainRouter CLI — Premium interactive terminal-based agent client.')
  .version(VERSION);

registerChatCommand(program);
registerRunCommand(program);
registerLoginCommand(program);
registerConfigCommand(program);
registerAgentsCommand(program);
registerFleetCommand(program);
registerPluginCommand(program);

program.parse(process.argv);
