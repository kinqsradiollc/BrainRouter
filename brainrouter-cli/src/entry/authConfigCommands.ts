import type { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { loadOrInitConfig, saveConfig } from '@kinqs/brainrouter-core/config';
import { McpClientWrapper } from '@kinqs/brainrouter-core/mcp';

export function registerLoginCommand(program: Command): void {
  // Login Command
  program
    .command('login')
    .description('Configure and authenticate connection to a hosted HTTP/SSE BrainRouter server')
    .action(async () => {
      console.log(chalk.bold.hex('#8B7CFF')('\nHosted authentication'));

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
        }, undefined, answers.profileName);
        await mcpClient.close();

        // Save to config — `loadOrInitConfig` lets first-run users build a
        // fresh config.json instead of hitting the strict no-config error.
        const config = loadOrInitConfig();
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
}

export function registerConfigCommand(program: Command): void {
  // Config Command
  program
    .command('config')
    .description('Interactively configure your LLM provider and MCP servers')
    .action(async () => {
      // `loadOrInitConfig` because this command IS the first-run setup
      // wizard — it must work even when no config.json exists yet.
      const config = loadOrInitConfig();

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
}
