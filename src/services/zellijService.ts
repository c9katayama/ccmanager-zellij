import {exec, execSync} from 'child_process';
import {promisify} from 'util';
import {resolve} from 'path';

const execAsync = promisify(exec);

export class ZellijService {
	/**
	 * Check if Zellij is available
	 */
	static isZellijAvailable(): boolean {
		try {
			execSync('which zellij', {stdio: 'ignore'});
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Check if currently running inside Zellij
	 */
	static isInsideZellij(): boolean {
		return process.env['ZELLIJ'] !== undefined;
	}

	/**
	 * Create a new Zellij pane for the worktree
	 */
	static async createWorktreePane(
		worktreePath: string,
		branchName: string,
		commandType: 'claude' | 'codex' = 'claude',
	): Promise<{success: boolean; error?: string}> {
		if (!this.isZellijAvailable()) {
			return {
				success: false,
				error: 'Zellij is not available. Please install Zellij first.',
			};
		}

		if (!this.isInsideZellij()) {
			return {
				success: false,
				error:
					'Not running inside Zellij session. Please start CCManager within Zellij.',
			};
		}

		try {
			// Create a descriptive name for the pane
			const paneName = `${branchName.replace(/[^a-zA-Z0-9-_]/g, '-')}`;

			// Get command and arguments based on commandType
			let command: string;
			let args: string[];

			if (commandType === 'codex') {
				command = 'codex';
				args = process.env['CCMANAGER_CODEX_ARGS']
					? process.env['CCMANAGER_CODEX_ARGS'].split(' ')
					: [];
			} else {
				command = 'claude';
				args = process.env['CCMANAGER_CLAUDE_ARGS']
					? process.env['CCMANAGER_CLAUDE_ARGS'].split(' ')
					: [];
			}

			// Build the full command
			const fullCommand = [command, ...args].join(' ');

			// Create new pane with the command
			const zellijCommand = [
				'zellij',
				'action',
				'new-pane',
				'--name',
				`"${paneName}"`,
				'--cwd',
				`"${worktreePath}"`,
				'--',
				'bash',
				'-c',
				`"echo 'Starting ${commandType} in worktree: ${branchName}'; echo 'Path: ${worktreePath}'; echo; ${fullCommand}"`,
			];

			await execAsync(zellijCommand.join(' '));

			return {success: true};
		} catch (error) {
			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: 'Failed to create Zellij pane',
			};
		}
	}

	/**
	 * Create a new Zellij tab for the worktree
	 */
	static async createWorktreeTab(
		worktreePath: string,
		branchName: string,
		commandType: 'claude' | 'codex' = 'claude',
	): Promise<{success: boolean; error?: string}> {
		if (!this.isZellijAvailable()) {
			return {
				success: false,
				error: 'Zellij is not available. Please install Zellij first.',
			};
		}

		if (!this.isInsideZellij()) {
			return {
				success: false,
				error:
					'Not running inside Zellij session. Please start CCManager within Zellij.',
			};
		}

		try {
			// Create a descriptive name for the tab
			const tabName = `${branchName.replace(/[^a-zA-Z0-9-_]/g, '-')}`;

			// Convert to absolute path if needed
			const absoluteWorktreePath = resolve(worktreePath);

			// Get command and arguments based on commandType
			let command: string;
			let args: string[];

			if (commandType === 'codex') {
				command = 'codex';
				args = process.env['CCMANAGER_CODEX_ARGS']
					? process.env['CCMANAGER_CODEX_ARGS'].split(' ')
					: [];
			} else {
				command = 'claude';
				args = process.env['CCMANAGER_CLAUDE_ARGS']
					? process.env['CCMANAGER_CLAUDE_ARGS'].split(' ')
					: [];
			}

			// Build the full command
			const fullCommand = [command, ...args].join(' ');

			// Check if command is available
			try {
				execSync(`which ${command}`, {stdio: 'ignore'});
			} catch {
				throw new Error(`Command '${command}' not found in PATH`);
			}

			// Debug logging
			console.log(`Creating Zellij pane: ${tabName} (${commandType})`);

			const createPaneCommand = [
				'zellij',
				'action',
				'new-pane',
				'--name',
				tabName,
				'--cwd',
				absoluteWorktreePath,
			];

			// Step 1: Create new pane
			await execAsync(createPaneCommand.join(' '));

			// Step 2: Wait for pane to be ready
			await new Promise(resolve => setTimeout(resolve, 300));

			// Step 3: Send command sequence
			const commands = [
				`echo 'Starting ${commandType}...'`,
				`cd "${absoluteWorktreePath}"`,
				`${fullCommand}`,
			];

			// Execute commands in sequence
			for (const command of commands) {
				await execAsync(`zellij action write-chars "${command}"`);
				await execAsync('zellij action write 13');
				await new Promise(resolve => setTimeout(resolve, 100));
			}

			console.log(`✅ Successfully created Zellij pane for ${commandType}`);

			return {success: true};
		} catch (error) {
			console.error('❌ Zellij pane creation failed:', error);
			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: 'Failed to create Zellij pane',
			};
		}
	}

	/**
	 * Get the current Zellij session name
	 */
	static getCurrentSessionName(): string | null {
		return process.env['ZELLIJ_SESSION_NAME'] || null;
	}

	/**
	 * Check if a specific pane exists by name
	 */
	static async paneExists(paneName: string): Promise<boolean> {
		if (!this.isInsideZellij()) {
			return false;
		}

		try {
			const {stdout} = await execAsync('zellij action query-tab-names');
			return stdout.includes(paneName);
		} catch {
			return false;
		}
	}

	/**
	 * Check if a specific pane is active by monitoring process activity
	 */
	static async isPaneActive(paneName: string, commandType: 'claude' | 'codex'): Promise<boolean> {
		if (!this.isInsideZellij()) {
			return false;
		}

		try {
			// Get process information with CPU usage and start time
			const {stdout} = await execAsync(`ps -eo pid,ppid,pcpu,etime,comm,args | grep -v grep | grep "${commandType}"`);
			
			if (!stdout.trim()) {
				return false; // No process found
			}

			const processes = stdout.trim().split('\n');
			
			for (const process of processes) {
				const fields = process.trim().split(/\s+/);
				if (fields.length >= 4 && fields[2] && fields[3]) {
					const cpuUsage = parseFloat(fields[2]);
					const elapsedTime = fields[3];
					
					// Consider active if:
					// 1. CPU usage > 0.1% (actively processing)
					// 2. Or recently started (less than 30 seconds old and CPU > 0)
					if (cpuUsage > 0.1) {
						return true;
					}
					
					// Check if recently started and has some CPU usage
					if (cpuUsage > 0 && this.isRecentlyStarted(elapsedTime)) {
						return true;
					}
				}
			}
			
			// If processes exist but no significant CPU usage, check if waiting for input
			return this.isWaitingForInput(commandType);
		} catch (error) {
			// Fallback to simpler process check
			return this.isProcessRunning(commandType);
		}
	}

	/**
	 * Check if process was recently started (within 30 seconds)
	 */
	private static isRecentlyStarted(elapsedTime: string): boolean {
		try {
			// Parse elapsed time format like "00:30" or "1:30" or "1-00:30:00"
			const parts = elapsedTime.split('-');
			const timePart = parts[parts.length - 1];
			if (!timePart) return false;
			
			const timeComponents = timePart.split(':');
			
			if (timeComponents.length >= 2 && timeComponents[0] && timeComponents[1]) {
				const minutes = parseInt(timeComponents[0]);
				const seconds = parseInt(timeComponents[1]);
				const totalSeconds = minutes * 60 + seconds;
				
				return totalSeconds < 30; // Recently started if less than 30 seconds
			}
		} catch {
			// If parsing fails, assume not recent
		}
		return false;
	}

	/**
	 * Check if the command is waiting for input (more sophisticated check)
	 */
	private static async isWaitingForInput(commandType: 'claude' | 'codex'): Promise<boolean> {
		try {
			// Use lsof to check if the process has open stdin/stdout
			const {stdout} = await execAsync(`lsof -c ${commandType} 2>/dev/null | grep -E "(stdin|stdout|pts)" | wc -l`);
			const openFiles = parseInt(stdout.trim());
			
			// If process has open terminal files, it's likely waiting for input
			return openFiles > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Check if process is running
	 */
	static async isProcessRunning(commandType: 'claude' | 'codex'): Promise<boolean> {
		try {
			const {stdout} = await execAsync(`ps aux | grep -v grep | grep "${commandType}"`);
			const processes = stdout.trim().split('\n').filter(line => line.length > 0);
			return processes.length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Get the branch name from worktree path for pane naming
	 */
	static getBranchNameFromPath(worktreePath: string): string {
		// Extract branch name from path like /path/to/feature-branch -> feature-branch
		const parts = worktreePath.split('/');
		const lastPart = parts[parts.length - 1];
		return (lastPart || 'unknown').replace(/[^a-zA-Z0-9-_]/g, '-');
	}
}
