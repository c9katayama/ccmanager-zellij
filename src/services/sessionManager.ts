import {spawn, IPty} from 'node-pty';
import {
	Session,
	SessionManager as ISessionManager,
	SessionState,
	CommandType,
} from '../types/index.js';
import {EventEmitter} from 'events';
import pkg from '@xterm/headless';
import {exec} from 'child_process';
import {configurationManager} from './configurationManager.js';
import {WorktreeService} from './worktreeService.js';
import {ZellijService} from './zellijService.js';
const {Terminal} = pkg;
type TerminalType = InstanceType<typeof Terminal>;

export class SessionManager extends EventEmitter implements ISessionManager {
	sessions: Map<string, Session>;
	private waitingWithBottomBorder: Map<string, boolean> = new Map();
	private busyTimers: Map<string, NodeJS.Timeout> = new Map();
	private zellijStatusTimer?: NodeJS.Timeout;

	private stripAnsi(str: string): string {
		// Remove all ANSI escape sequences including cursor movement, color codes, etc.
		return str
			.replace(/\x1b\[[0-9;]*m/g, '') // Color codes (including 24-bit)
			.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // CSI sequences
			.replace(/\x1b\][^\x07]*\x07/g, '') // OSC sequences
			.replace(/\x1b[PX^_].*?\x1b\\/g, '') // DCS/PM/APC/SOS sequences
			.replace(/\x1b\[\?[0-9;]*[hl]/g, '') // Private mode sequences
			.replace(/\x1b[>=]/g, '') // Other escape sequences
			.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '') // Control characters except newline (\x0A)
			.replace(/\r/g, '') // Carriage returns
			.replace(/^[0-9;]+m/gm, '') // Orphaned color codes at line start
			.replace(/[0-9]+;[0-9]+;[0-9;]+m/g, ''); // Orphaned 24-bit color codes
	}

	detectTerminalState(terminal: InstanceType<typeof Terminal>): SessionState {
		// Get the last 30 lines from the terminal buffer
		const buffer = terminal.buffer.active;
		const lines: string[] = [];

		// Start from the bottom and work our way up
		for (let i = buffer.length - 1; i >= 0 && lines.length < 30; i--) {
			const line = buffer.getLine(i);
			if (line) {
				const text = line.translateToString(true);
				// Skip empty lines at the bottom
				if (lines.length > 0 || text.trim() !== '') {
					lines.unshift(text);
				}
			}
		}

		// Join lines and check for patterns
		const content = lines.join('\n');
		const lowerContent = content.toLowerCase();

		// Check for waiting prompts with box character
		if (
			content.includes('│ Do you want') ||
			content.includes('│ Would you like')
		) {
			return 'waiting_input';
		}

		// Check for busy state
		if (lowerContent.includes('esc to interrupt')) {
			return 'busy';
		}

		// Otherwise idle
		return 'idle';
	}

	constructor() {
		super();
		this.sessions = new Map();

		// Start Zellij status monitoring if we're inside Zellij
		if (ZellijService.isInsideZellij()) {
			this.startZellijStatusMonitoring();
		}
	}

	createSession(
		worktreePath: string,
		commandType: CommandType = 'claude',
		isZellijSession: boolean = false,
	): Session {
		// Check if session already exists
		const existing = this.sessions.get(worktreePath);
		if (existing) {
			return existing;
		}

		const id = `session-${Date.now()}-${Math.random()
			.toString(36)
			.substr(2, 9)}`;

		// Determine command and arguments based on commandType
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

		let ptyProcess: IPty | null;
		let terminal: TerminalType | null;

		if (isZellijSession) {
			// For Zellij sessions, no actual PTY process needed
			ptyProcess = null;
			terminal = null;
		} else {
			// Normal session with actual PTY process
			ptyProcess = spawn(command, args, {
				name: 'xterm-color',
				cols: process.stdout.columns || 80,
				rows: process.stdout.rows || 24,
				cwd: worktreePath,
				env: process.env,
			});

			// Create virtual terminal for state detection
			terminal = new Terminal({
				cols: process.stdout.columns || 80,
				rows: process.stdout.rows || 24,
				allowProposedApi: true,
			});
		}

		const session: Session = {
			id,
			worktreePath,
			process: ptyProcess,
			state: isZellijSession ? 'idle' : 'busy',
			output: [],
			outputHistory: [],
			lastActivity: new Date(),
			isActive: false,
			terminal,
			commandType,
			isZellijSession,
		};

		// Set up persistent background data handler for state detection
		this.setupBackgroundHandler(session);

		this.sessions.set(worktreePath, session);

		this.emit('sessionCreated', session);

		return session;
	}

	private setupBackgroundHandler(session: Session): void {
		// Skip setup for Zellij sessions as they don't have real PTY processes
		if (session.isZellijSession) {
			return;
		}

		// This handler always runs for all data
		session.process?.onData((data: string) => {
			// Write data to virtual terminal
			session.terminal?.write(data);

			// Store in output history as Buffer
			const buffer = Buffer.from(data, 'utf8');
			session.outputHistory.push(buffer);

			// Limit memory usage - keep max 10MB of output history
			const MAX_HISTORY_SIZE = 10 * 1024 * 1024; // 10MB
			let totalSize = session.outputHistory.reduce(
				(sum, buf) => sum + buf.length,
				0,
			);
			while (totalSize > MAX_HISTORY_SIZE && session.outputHistory.length > 0) {
				const removed = session.outputHistory.shift();
				if (removed) {
					totalSize -= removed.length;
				}
			}

			session.lastActivity = new Date();

			// Only emit data events when session is active
			if (session.isActive) {
				this.emit('sessionData', session, data);
			}
		});

		// Set up interval-based state detection
		session.stateCheckInterval = setInterval(() => {
			const oldState = session.state;
			const newState = session.terminal
				? this.detectTerminalState(session.terminal)
				: 'idle';

			if (newState !== oldState) {
				session.state = newState;
				this.executeStatusHook(oldState, newState, session);
				this.emit('sessionStateChanged', session);
			}
		}, 100); // Check every 100ms

		session.process?.onExit(() => {
			// Clear the state check interval
			if (session.stateCheckInterval) {
				clearInterval(session.stateCheckInterval);
			}
			// Update state to idle before destroying
			session.state = 'idle';
			this.emit('sessionStateChanged', session);
			this.destroySession(session.worktreePath);
			this.emit('sessionExit', session);
		});
	}

	getSession(worktreePath: string): Session | undefined {
		return this.sessions.get(worktreePath);
	}

	setSessionActive(worktreePath: string, active: boolean): void {
		const session = this.sessions.get(worktreePath);
		if (session) {
			session.isActive = active;

			// If becoming active, emit a restore event with the output history
			if (active && session.outputHistory.length > 0) {
				this.emit('sessionRestore', session);
			}
		}
	}

	destroySession(worktreePath: string): void {
		const session = this.sessions.get(worktreePath);
		if (session) {
			// Clear the state check interval
			if (session.stateCheckInterval) {
				clearInterval(session.stateCheckInterval);
			}
			try {
				session.process?.kill();
			} catch (_error) {
				// Process might already be dead
			}
			// Clean up any pending timer
			const timer = this.busyTimers.get(worktreePath);
			if (timer) {
				clearTimeout(timer);
				this.busyTimers.delete(worktreePath);
			}
			this.sessions.delete(worktreePath);
			this.waitingWithBottomBorder.delete(session.id);
			this.emit('sessionDestroyed', session);
		}
	}

	getAllSessions(): Session[] {
		return Array.from(this.sessions.values());
	}

	private executeStatusHook(
		oldState: SessionState,
		newState: SessionState,
		session: Session,
	): void {
		const statusHooks = configurationManager.getStatusHooks();
		const hook = statusHooks[newState];

		if (hook && hook.enabled && hook.command) {
			// Get branch information
			const worktreeService = new WorktreeService();
			const worktrees = worktreeService.getWorktrees();
			const worktree = worktrees.find(wt => wt.path === session.worktreePath);
			const branch = worktree?.branch || 'unknown';

			// Execute the hook command in the session's worktree directory
			exec(
				hook.command,
				{
					cwd: session.worktreePath,
					env: {
						...process.env,
						CCMANAGER_OLD_STATE: oldState,
						CCMANAGER_NEW_STATE: newState,
						CCMANAGER_WORKTREE: session.worktreePath,
						CCMANAGER_WORKTREE_BRANCH: branch,
						CCMANAGER_SESSION_ID: session.id,
					},
				},
				(error, _stdout, stderr) => {
					if (error) {
						console.error(
							`Failed to execute ${newState} hook: ${error.message}`,
						);
					}
					if (stderr) {
						console.error(`Hook stderr: ${stderr}`);
					}
				},
			);
		}
	}

	/**
	 * Start monitoring Zellij session statuses
	 */
	private startZellijStatusMonitoring(): void {
		const updateZellijSessionStates = async () => {
			const zellijSessions = Array.from(this.sessions.values()).filter(
				s => s.isZellijSession,
			);

			for (const session of zellijSessions) {
				try {
					const paneName = ZellijService.getBranchNameFromPath(
						session.worktreePath,
					);
					const isActive = await ZellijService.isPaneActive(
						paneName,
						session.commandType,
					);

					// More nuanced state detection
					let newState: SessionState;
					if (isActive) {
						// If active, it could be busy processing or waiting for input
						// For Zellij sessions, we'll use a simpler busy/idle model
						newState = 'busy';
					} else {
						// Check if process exists but is idle
						const processExists = await ZellijService.isProcessRunning(
							session.commandType,
						);
						newState = processExists ? 'idle' : 'idle'; // Process ended
					}

					if (session.state !== newState) {
						const oldState = session.state;
						session.state = newState;
						session.lastActivity = new Date();

						// Execute status hooks
						this.executeStatusHook(oldState, newState, session);

						// Emit state change event
						this.emit('sessionStateChanged', session);
					}
				} catch (error) {
					console.error('Error checking Zellij pane status:', error);
				}
			}
		};

		// Check every 2 seconds
		this.zellijStatusTimer = setInterval(updateZellijSessionStates, 2000);

		// Initial check
		updateZellijSessionStates();
	}

	/**
	 * Stop monitoring Zellij session statuses
	 */
	private stopZellijStatusMonitoring(): void {
		if (this.zellijStatusTimer) {
			clearInterval(this.zellijStatusTimer);
			this.zellijStatusTimer = undefined;
		}
	}

	/**
	 * Discover and restore existing sessions from Zellij panes
	 */
	async discoverExistingSessions(): Promise<Session[]> {
		if (!ZellijService.isInsideZellij()) {
			return [];
		}

		const discoveredSessions: Session[] = [];

		try {
			const existingPanes = await ZellijService.getExistingPanes();

			for (const pane of existingPanes) {
				// Skip if we already have a session for this worktree
				if (this.sessions.has(pane.cwd)) {
					continue;
				}

				// Create a new Zellij session for the existing pane
				const session = this.createSession(
					pane.cwd,
					pane.commandType || 'claude',
					true, // isZellijSession
				);

				// Set additional metadata from the discovered pane
				session.id = `zellij-${pane.id}`;
				session.lastActivity = new Date(); // Mark as recently active

				discoveredSessions.push(session);

				console.log(
					`✅ Discovered existing ${pane.commandType} session in: ${pane.cwd}`,
				);
			}

			// Start monitoring if we discovered any sessions
			if (discoveredSessions.length > 0 && !this.zellijStatusTimer) {
				this.startZellijStatusMonitoring();
			}
		} catch (error) {
			console.error('Error discovering existing sessions:', error);
		}

		return discoveredSessions;
	}

	/**
	 * Restore a specific session for a worktree if it exists in Zellij
	 */
	async restoreSessionForWorktree(
		worktreePath: string,
	): Promise<Session | null> {
		if (!ZellijService.isInsideZellij()) {
			return null;
		}

		// Check if session already exists
		if (this.sessions.has(worktreePath)) {
			return this.sessions.get(worktreePath) || null;
		}

		try {
			const paneInfo = await ZellijService.hasPaneForWorktree(worktreePath);

			if (paneInfo.exists && paneInfo.pane) {
				// Create a Zellij session for the existing pane
				const session = this.createSession(
					worktreePath,
					paneInfo.pane.commandType || 'claude',
					true, // isZellijSession
				);

				// Set metadata from the discovered pane
				session.id = `zellij-${paneInfo.pane.id}`;
				session.lastActivity = new Date();

				console.log(
					`✅ Restored ${paneInfo.pane.commandType} session for: ${worktreePath}`,
				);

				// Start monitoring if not already started
				if (!this.zellijStatusTimer) {
					this.startZellijStatusMonitoring();
				}

				return session;
			}
		} catch (error) {
			console.error(`Error restoring session for ${worktreePath}:`, error);
		}

		return null;
	}

	destroy(): void {
		// Stop Zellij monitoring
		this.stopZellijStatusMonitoring();

		// Clean up all sessions
		for (const worktreePath of this.sessions.keys()) {
			this.destroySession(worktreePath);
		}
	}
}
