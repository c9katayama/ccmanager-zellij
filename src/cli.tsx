#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
import {spawn} from 'child_process';
import {ZellijService} from './services/zellijService.js';
import App from './components/App.js';

const cli = meow(
	`
	Usage
	  $ ccmanager

	Options
	  --help        Show help
	  --version     Show version
	  --no-zellij   Skip automatic Zellij launch (run in current terminal)

	Examples
	  $ ccmanager                    # Auto-launch Zellij if not inside one
	  $ ccmanager --no-zellij        # Run directly without Zellij
`,
	{
		importMeta: import.meta,
		flags: {
			noZellij: {
				type: 'boolean',
				default: false,
			},
		},
	},
);

// Check if we're in a TTY environment
if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.error(
		'Error: ccmanager must be run in an interactive terminal (TTY)',
	);
	process.exit(1);
}

/**
 * Ensure Zellij config directory exists and create minimal config
 */
async function ensureZellijConfig(): Promise<void> {
	const {promises: fs} = await import('fs');
	const path = await import('path');

	const configDir =
		process.env['ZELLIJ_CONFIG_DIR'] || `${process.env['HOME']}/.config/zellij`;
	const configPath = path.join(configDir, 'config.kdl');

	try {
		await fs.access(configDir);
	} catch {
		await fs.mkdir(configDir, {recursive: true});
	}

	// Create minimal config to disable tips if config doesn't exist
	try {
		await fs.access(configPath);
	} catch {
		const minimalConfig = `
// Minimal Zellij config for CCManager
simplified_ui true
default_shell "bash"
pane_frames false
`;
		await fs.writeFile(configPath, minimalConfig);
	}
}

/**
 * Launch CCManager inside Zellij with clear user instructions
 */
async function launchInZellij(): Promise<void> {
	console.log('🚀 Starting CCManager in Zellij...');
	console.log('');
	console.log('📋 What will happen:');
	console.log('   1. A unique Zellij session will be created');
	console.log('   2. You will be placed inside the Zellij environment');
	console.log('   3. CCManager will start automatically via configuration');
	console.log('');
	console.log(
		"💡 If CCManager doesn't start automatically, run: ccmanager --no-zellij",
	);
	console.log('💡 Press Ctrl+P followed by D to detach from Zellij later');
	console.log('');

	// Ensure Zellij config exists to avoid tips screen
	await ensureZellijConfig();

	try {
		// Create a unique session name to avoid conflicts with existing sessions
		const sessionName = `ccmanager-${Date.now()}`;

		console.log(`🎯 Creating new Zellij session: ${sessionName}`);

		// Create new session with unique name to avoid conflicts
		const zellijProcess = spawn('zellij', ['attach', '--create', sessionName], {
			stdio: 'inherit',
			cwd: process.cwd(),
			env: {
				...process.env,
				ZELLIJ_CONFIG_DIR:
					process.env['ZELLIJ_CONFIG_DIR'] ||
					`${process.env['HOME']}/.config/zellij`,
				// Set environment variable so we can detect we need to run ccmanager
				CCMANAGER_AUTO_START: '1',
			},
		});

		zellijProcess.on('error', error => {
			console.error('❌ Failed to start Zellij:');
			console.error(`   ${error.message}`);
			console.error('\n💡 Solutions:');
			console.error(
				'   1. Install Zellij: https://zellij.dev/documentation/installation',
			);
			console.error(
				'   2. Run with --no-zellij flag to skip Zellij integration',
			);
			console.error('   3. Use: ccmanager --no-zellij');
			process.exit(1);
		});

		zellijProcess.on('exit', code => {
			console.log('\n👋 Zellij session ended');
			if (code !== null && code !== 0) {
				console.log(`   Exit code: ${code}`);
			}
		});
	} catch (error) {
		console.error('❌ Failed to start Zellij session:', error);
		console.error('💡 Falling back to direct mode...');
		render(<App />);
	}
}

/**
 * Main execution logic
 */
async function main(): Promise<void> {
	// If --no-zellij flag is provided, run directly
	if (cli.flags.noZellij) {
		console.log('🖥️  Running CCManager directly (without Zellij)...');
		render(<App />);
		return;
	}

	// Check if we're already inside Zellij
	if (ZellijService.isInsideZellij()) {
		console.log('✅ Already inside Zellij session');

		// Clear console before rendering to prevent double display
		process.stdout.write('\x1B[2J\x1B[H');

		render(<App />, {
			stdout: process.stdout,
			stdin: process.stdin,
		});
		return;
	}

	// Check if Zellij is available
	if (!ZellijService.isZellijAvailable()) {
		console.log(
			'⚠️  Zellij not found. Running directly without Zellij integration.',
		);
		console.log(
			'💡 Install Zellij for the best experience: https://zellij.dev/documentation/installation\n',
		);
		render(<App />);
		return;
	}

	// Launch in Zellij
	await launchInZellij();
}

// Execute main function
main().catch(error => {
	console.error('❌ Unexpected error:', error);
	process.exit(1);
});
