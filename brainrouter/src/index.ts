#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { loadConfig, saveConfig } from './config.js';
import { McpClientWrapper } from './mcpClient.js';
import { Agent } from './agent.js';
import { startREPL } from './repl.js';
import { applyWorkspaceRoot, findWorkspaceRoot } from './workspace.js';

const program = new Command();

program
  .name('brainrouter')
  .description('BrainRouter CLI — Premium interactive terminal-based agent client.')
  .version('0.2.0');

// Chat Command (default)
program
  .command('chat', { isDefault: true })
  .description('Start interactive agent REPL chat session (default)')
  .option('-p, --profile <name>', 'Connection profile name')
  .option('-m, --model <name>', 'LLM model override')
  .option('-w, --workspace <path>', 'Workspace root for files, commands, memory session, and MCP --root')
  .action(async (options) => {
    if (options.workspace) {
      process.env.BRAINROUTER_WORKSPACE = options.workspace;
    }
    const workspace = findWorkspaceRoot();
    applyWorkspaceRoot(workspace.workspaceRoot);
    console.log(chalk.gray(`Workspace: ${workspace.workspaceRoot} (${workspace.reason})`));

    const config = loadConfig();
    const profileName = options.profile || config.activeServer;
    const configuredServer = config.servers[profileName];

    if (!configuredServer) {
      console.error(chalk.red(`Error: Profile "${profileName}" not found in config.`));
      process.exit(1);
    }

    const serverConfig = { ...configuredServer };

    if (serverConfig.type === 'stdio') {
      const args = serverConfig.args ?? [];
      const rootIndex = args.indexOf('--root');
      serverConfig.args = rootIndex >= 0
        ? [...args.slice(0, rootIndex + 1), workspace.workspaceRoot, ...args.slice(rootIndex + 2)]
        : [...args, '--root', workspace.workspaceRoot];
    }
    config.servers[profileName] = serverConfig;

    const llm = config.llm || {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: ''
    };

    if (options.model) {
      llm.model = options.model;
    }

    const mcpClient = new McpClientWrapper();
    console.log(chalk.gray(`Connecting to MCP server profile "${profileName}"...`));

    try {
      await mcpClient.connect(serverConfig, llm);
      console.log(chalk.green('Successfully connected to BrainRouter MCP Server!'));
    } catch (err: any) {
      console.error(chalk.red(`Failed to connect to MCP server: ${err.message}`));
      process.exit(1);
    }

    const agent = new Agent(mcpClient, llm, {
      workspaceRoot: workspace.workspaceRoot,
      launchCwd: workspace.launchCwd,
    });
    startREPL(agent, mcpClient, config, workspace);
  });

// Login Command
program
  .command('login')
  .description('Configure and authenticate connection to a hosted HTTP/SSE BrainRouter server')
  .action(async () => {
    console.log(chalk.bold.hex('#CC9166')('\n🔑 hosted BrainRouter Authentication Setup'));

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'url',
        message: 'Enter BrainRouter HTTP/SSE MCP Endpoint URL:',
        default: 'http://localhost:3747/mcp',
        validate: (input) => {
          try {
            new URL(input);
            return true;
          } catch {
            return 'Please enter a valid URL (e.g. http://localhost:3747/mcp)';
          }
        }
      },
      {
        type: 'input',
        name: 'apiKey',
        message: 'Enter Authorization / API Key (leave empty if none):',
      },
      {
        type: 'input',
        name: 'profileName',
        message: 'Enter profile name to save this connection as:',
        default: 'hosted-team',
        validate: (input) => input.trim() ? true : 'Profile name cannot be empty.'
      }
    ]);

    const mcpClient = new McpClientWrapper();
    const spinner = inquirer.ui.BottomBar ? null : console.log(chalk.gray('Testing connection...'));
    
    try {
      await mcpClient.connect({
        type: 'http',
        url: answers.url,
        apiKey: answers.apiKey || undefined
      });
      await mcpClient.close();

      // Save to config
      const config = loadConfig();
      config.servers[answers.profileName] = {
        type: 'http',
        url: answers.url,
        apiKey: answers.apiKey || undefined
      };
      config.activeServer = answers.profileName;
      saveConfig(config);

      console.log(chalk.green(`\n✔ Successfully connected and saved profile "${answers.profileName}"!`));
      console.log(`Set "${answers.profileName}" as the active connection profile.\n`);
    } catch (err: any) {
      console.error(chalk.red(`\n✖ Connection test failed: ${err.message}`));
      console.log(chalk.yellow('No profile changes were saved. Check the URL and credentials and try again.\n'));
    }
  });

// Config Command
program
  .command('config')
  .description('Interactively configure your LLM provider and MCP servers')
  .action(async () => {
    const config = loadConfig();

    const menu = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Select configuration action:',
        choices: [
          'Configure LLM Provider',
          'Configure Server Profile',
          'Set Active Server Profile',
          'View Configuration',
          'Cancel'
        ]
      }
    ]);

    if (menu.action === 'Configure LLM Provider') {
      const llmAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'apiKey',
          message: 'Enter LLM API Key (leave blank to use system env variables or local endpoints):',
          default: config.llm?.apiKey || ''
        },
        {
          type: 'input',
          name: 'model',
          message: 'Enter LLM Model (e.g. gpt-4o-mini, llama3):',
          default: config.llm?.model || 'gpt-4o-mini'
        },
        {
          type: 'input',
          name: 'endpoint',
          message: 'Enter Custom API Endpoint URL (optional, e.g. for Ollama/LM Studio):',
          default: config.llm?.endpoint || ''
        }
      ]);

      config.llm = {
        provider: 'openai',
        apiKey: llmAnswers.apiKey,
        model: llmAnswers.model,
        endpoint: llmAnswers.endpoint || undefined
      };
      saveConfig(config);
      console.log(chalk.green('\n✔ LLM configuration updated successfully!\n'));

    } else if (menu.action === 'Configure Server Profile') {
      const typeAnswer = await inquirer.prompt([
        {
          type: 'list',
          name: 'type',
          message: 'Select connection type:',
          choices: ['stdio', 'http']
        }
      ]);

      let serverOpts: any = { type: typeAnswer.type };

      if (typeAnswer.type === 'stdio') {
        const stdioAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'command',
            message: 'Enter executable command (e.g., node, npx):',
            default: 'node'
          },
          {
            type: 'input',
            name: 'args',
            message: 'Enter space-separated arguments (e.g. dist/index.js --root .):',
          }
        ]);
        serverOpts.command = stdioAnswers.command;
        serverOpts.args = stdioAnswers.args.trim() ? stdioAnswers.args.split(' ') : [];
      } else {
        const httpAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'url',
            message: 'Enter Server URL (e.g., http://localhost:3747/mcp):',
            default: 'http://localhost:3747/mcp'
          },
          {
            type: 'input',
            name: 'apiKey',
            message: 'Enter API authorization key (if any):'
          }
        ]);
        serverOpts.url = httpAnswers.url;
        serverOpts.apiKey = httpAnswers.apiKey || undefined;
      }

      const nameAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'name',
          message: 'Enter profile name for this server:',
          default: 'custom-server'
        }
      ]);

      config.servers[nameAnswer.name] = serverOpts;
      saveConfig(config);
      console.log(chalk.green(`\n✔ Server profile "${nameAnswer.name}" saved successfully!\n`));

    } else if (menu.action === 'Set Active Server Profile') {
      const activeChoices = Object.keys(config.servers);
      if (activeChoices.length === 0) {
        console.log(chalk.red('\nNo server profiles exist. Create one first.\n'));
        return;
      }

      const activeAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'active',
          message: 'Select active server profile:',
          choices: activeChoices,
          default: config.activeServer
        }
      ]);

      config.activeServer = activeAnswers.active;
      saveConfig(config);
      console.log(chalk.green(`\n✔ Active server profile set to "${activeAnswers.active}"!\n`));

    } else if (menu.action === 'View Configuration') {
      console.log(chalk.bold('\n⚙️  Current configuration:'));
      const scrubbed = JSON.parse(JSON.stringify(config));
      if (scrubbed.llm?.apiKey) scrubbed.llm.apiKey = 'br_••••••••';
      for (const s of Object.values(scrubbed.servers)) {
        const srv = s as any;
        if (srv.apiKey) srv.apiKey = 'br_••••••••';
        if (srv.env?.BRAINROUTER_API_KEY) srv.env.BRAINROUTER_API_KEY = 'br_••••••••';
      }
      console.log(chalk.gray(JSON.stringify(scrubbed, null, 2)));
      console.log();
    }
  });

program.parse(process.argv);
