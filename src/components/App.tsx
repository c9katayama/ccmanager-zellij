import React, {useState, useEffect, useRef} from 'react';
import {useApp, Box, Text} from 'ink';
import Menu from './Menu.js';
import Session from './Session.js';
import NewWorktree from './NewWorktree.js';
import DeleteWorktree from './DeleteWorktree.js';
import MergeWorktree from './MergeWorktree.js';
import Configuration from './Configuration.js';
import CommandSelection from './CommandSelection.js';
import {SessionManager} from '../services/sessionManager.js';
import {WorktreeService} from '../services/worktreeService.js';
import {ZellijService} from '../services/zellijService.js';
import {Worktree, Session as SessionType, CommandType} from '../types/index.js';
import {shortcutManager} from '../services/shortcutManager.js';
import {
	checkCommandAvailability,
	getDefaultCommandType,
	shouldShowCommandSelection,
	CommandAvailability,
} from '../utils/commandChecker.js';

// Global flag to prevent title duplication
let titleRendered = false;

type View =
	| 'menu'
	| 'session'
	| 'command-selection'
	| 'new-worktree'
	| 'creating-worktree'
	| 'delete-worktree'
	| 'deleting-worktree'
	| 'merge-worktree'
	| 'merging-worktree'
	| 'configuration'
	| 'no-commands-available';

const App: React.FC = React.memo(function App() {
	const {exit} = useApp();
	const [view, setView] = useState<View>('menu');
	const sessionManagerRef = useRef<SessionManager | null>(null);
	const worktreeServiceRef = useRef<WorktreeService | null>(null);

	// Initialize services only once
	if (!sessionManagerRef.current) {
		sessionManagerRef.current = new SessionManager();
	}
	if (!worktreeServiceRef.current) {
		worktreeServiceRef.current = new WorktreeService();
	}

	const sessionManager = sessionManagerRef.current;
	const worktreeService = worktreeServiceRef.current;
	const [activeSession, setActiveSession] = useState<SessionType | null>(null);
	const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);
	const [menuKey, setMenuKey] = useState(0); // Force menu refresh
	const [commandAvailability, setCommandAvailability] =
		useState<CommandAvailability | null>(null);
	const [isZellijAvailable, setIsZellijAvailable] = useState(false);
	const [isInsideZellij, setIsInsideZellij] = useState(false);
	const [isInitialized, setIsInitialized] = useState(false);

	useEffect(() => {
		// Prevent double initialization
		if (isInitialized) return;

		// Batch all initial state updates
		const availability = checkCommandAvailability();
		const zellijAvailable = ZellijService.isZellijAvailable();
		const insideZellij = ZellijService.isInsideZellij();

		// Use a single state update batch
		setCommandAvailability(availability);
		setIsZellijAvailable(zellijAvailable);
		setIsInsideZellij(insideZellij);
		setIsInitialized(true);

		// If no commands are available, show error view
		if (availability.available.length === 0) {
			setView('no-commands-available');
			return;
		}

		// Discover and restore existing sessions if inside Zellij
		if (zellijAvailable && insideZellij) {
			const discoverSessions = async () => {
				try {
					const discoveredSessions =
						await sessionManager.discoverExistingSessions();
					if (discoveredSessions.length > 0) {
						console.log(
							`✅ Discovered ${discoveredSessions.length} existing sessions`,
						);
						// Force refresh menu to show restored sessions
						setMenuKey(prev => prev + 1);
					}
				} catch (error) {
					console.error('Error discovering existing sessions:', error);
				}
			};

			// Delay session discovery to allow UI to initialize
			setTimeout(discoverSessions, 100);
		}
	}, [isInitialized, sessionManager]); // Include all dependencies

	useEffect(() => {
		// Listen for session exits to return to menu automatically
		const handleSessionExit = (session: SessionType) => {
			// If the exited session is the active one, return to menu
			setActiveSession(current => {
				if (current && session.id === current.id) {
					// Session that exited is the active one, trigger return to menu
					setTimeout(() => {
						setActiveSession(null);
						setError(null);
						setView('menu');
						setMenuKey(prev => prev + 1);
						if (process.stdout.isTTY) {
							process.stdout.write('\x1B[2J\x1B[H');
						}
						process.stdin.resume();
						process.stdin.setEncoding('utf8');
					}, 0);
				}
				return current;
			});
		};

		sessionManager.on('sessionExit', handleSessionExit);

		// Cleanup on unmount
		return () => {
			sessionManager.off('sessionExit', handleSessionExit);
			sessionManager.destroy();
		};
	}, [sessionManager]); // sessionManager is stable via useRef

	const handleSelectWorktree = async (worktree: Worktree) => {
		// Check if this is the new worktree option
		if (worktree.path === '') {
			setView('new-worktree');
			return;
		}

		// Check if this is the delete worktree option
		if (worktree.path === 'DELETE_WORKTREE') {
			setView('delete-worktree');
			return;
		}

		// Check if this is the merge worktree option
		if (worktree.path === 'MERGE_WORKTREE') {
			setView('merge-worktree');
			return;
		}

		// Check if this is the configuration option
		if (worktree.path === 'CONFIGURATION') {
			setView('configuration');
			return;
		}

		// Check if this is the exit application option
		if (worktree.path === 'EXIT_APPLICATION') {
			sessionManager.destroy();
			exit();
			return;
		}

		// Get existing session or try to restore from Zellij, then create new session
		let session = sessionManager.getSession(worktree.path);

		// If no session exists and we're in Zellij, try to restore from existing pane
		if (!session && isZellijAvailable && isInsideZellij) {
			try {
				const restoredSession = await sessionManager.restoreSessionForWorktree(
					worktree.path,
				);
				if (restoredSession) {
					session = restoredSession;
				}
				if (session) {
					console.log(`✅ Restored existing session for: ${worktree.path}`);

					// Focus the existing pane
					const focusResult = await ZellijService.focusPaneByWorktree(
						worktree.path,
					);
					if (focusResult.success) {
						console.log(`✅ Focused existing pane for: ${worktree.path}`);
					} else {
						console.warn(`⚠️ Could not focus pane: ${focusResult.error}`);
					}

					// Force refresh menu to show restored session
					setMenuKey(prev => prev + 1);
					return; // Session restored, no need to create new one
				}
			} catch (error) {
				console.error(`Error restoring session for ${worktree.path}:`, error);
			}
		}

		if (!session) {
			// No existing session, check command availability
			if (!commandAvailability) return; // Wait for availability check

			// Check if we should use Zellij
			if (isZellijAvailable && isInsideZellij) {
				// Use Zellij to create a new tab/pane
				if (shouldShowCommandSelection(commandAvailability)) {
					// Multiple commands available, show selection
					setSelectedWorktree(worktree);
					setView('command-selection');
				} else {
					// Only one command available, create Zellij tab directly
					const defaultCommand = getDefaultCommandType(commandAvailability);
					if (defaultCommand) {
						const branchName = worktree.branch.replace('refs/heads/', '');
						const zellijResult = await ZellijService.createWorktreeTab(
							worktree.path,
							branchName,
							defaultCommand,
						);

						if (zellijResult.success) {
							// Create a placeholder session for status tracking
							sessionManager.createSession(worktree.path, defaultCommand, true);

							console.log(
								'Successfully created Zellij session for worktree:',
								worktree.path,
							);
							return;
						} else {
							console.error(
								'Failed to create Zellij session:',
								zellijResult.error,
							);
							setError(
								`Zellij integration failed: ${zellijResult.error}. Falling back to regular session.`,
							);

							// Fallback to regular session
							const session = sessionManager.createSession(
								worktree.path,
								defaultCommand,
							);
							setActiveSession(session);
							setView('session');
						}
					}
				}
			} else {
				// Fallback to traditional session management
				if (shouldShowCommandSelection(commandAvailability)) {
					// Multiple commands available, show selection
					setSelectedWorktree(worktree);
					setView('command-selection');
				} else {
					// Only one command available, create session directly
					const defaultCommand = getDefaultCommandType(commandAvailability);
					if (defaultCommand) {
						session = sessionManager.createSession(
							worktree.path,
							defaultCommand,
						);
						setActiveSession(session);
						setView('session');
					}
				}
			}
		} else {
			// Existing session found
			if (isZellijAvailable && isInsideZellij) {
				// In Zellij mode, focus the existing pane instead of opening session view
				try {
					const focusResult = await ZellijService.focusPaneByWorktree(
						worktree.path,
					);
					if (focusResult.success) {
						console.log(`✅ Focused existing pane for: ${worktree.path}`);
					} else {
						console.warn(`⚠️ Could not focus pane: ${focusResult.error}`);
						// Fallback: show session view
						setActiveSession(session);
						setView('session');
					}
				} catch (error) {
					console.error(`Error focusing pane for ${worktree.path}:`, error);
					// Fallback: show session view
					setActiveSession(session);
					setView('session');
				}
			} else {
				// Non-Zellij mode: open session view directly
				setActiveSession(session);
				setView('session');
			}
		}
	};

	const handleReturnToMenu = () => {
		setActiveSession(null);
		setSelectedWorktree(null);
		setError(null);

		// Add a small delay to ensure Session cleanup completes
		setTimeout(() => {
			setView('menu');
			setMenuKey(prev => prev + 1); // Force menu refresh

			// Clear the screen when returning to menu
			// Disabled to prevent double rendering
			// if (process.stdout.isTTY) {
			//	process.stdout.write('\x1B[2J\x1B[H');
			// }

			// Ensure stdin is in a clean state for Ink components
			if (process.stdin.isTTY) {
				// Flush any pending input to prevent escape sequences from leaking
				process.stdin.read();
				process.stdin.setRawMode(false);
				process.stdin.resume();
				process.stdin.setEncoding('utf8');
			}
		}, 50); // Small delay to ensure proper cleanup
	};

	const handleCreateWorktree = async (path: string, branch: string) => {
		setView('creating-worktree');
		setError(null);

		// Create the worktree
		const result = worktreeService.createWorktree(path, branch);

		if (result.success) {
			// Success - determine how to handle the new worktree
			const newWorktree: Worktree = {
				path: path,
				branch: `refs/heads/${branch}`,
				isMainWorktree: false,
				hasSession: false,
			};

			if (!commandAvailability) return; // Wait for availability check

			// Check if we should use Zellij
			if (isZellijAvailable && isInsideZellij) {
				// Use Zellij to create a new tab/pane
				if (shouldShowCommandSelection(commandAvailability)) {
					// Multiple commands available, show selection
					setSelectedWorktree(newWorktree);
					setView('command-selection');
				} else {
					// Only one command available, create Zellij tab directly
					const defaultCommand = getDefaultCommandType(commandAvailability);
					if (defaultCommand) {
						const zellijResult = await ZellijService.createWorktreeTab(
							newWorktree.path,
							branch,
							defaultCommand,
						);

						if (zellijResult.success) {
							// Create a placeholder session for status tracking
							sessionManager.createSession(
								newWorktree.path,
								defaultCommand,
								true,
							);

							console.log(
								'Successfully created Zellij session for new worktree:',
								newWorktree.path,
							);
							handleReturnToMenu();
						} else {
							console.error(
								'Failed to create Zellij session for new worktree:',
								zellijResult.error,
							);
							setError(
								`Zellij integration failed: ${zellijResult.error}. Please try again.`,
							);
							setView('new-worktree');
						}
					}
				}
			} else {
				// Fallback to traditional session management
				if (shouldShowCommandSelection(commandAvailability)) {
					// Multiple commands available, show selection
					setSelectedWorktree(newWorktree);
					setView('command-selection');
				} else {
					// Only one command available, create session directly
					const defaultCommand = getDefaultCommandType(commandAvailability);
					if (defaultCommand) {
						const session = sessionManager.createSession(
							newWorktree.path,
							defaultCommand,
						);
						setActiveSession(session);
						setView('session');
					}
				}
			}
		} else {
			// Show error
			setError(result.error || 'Failed to create worktree');
			setView('new-worktree');
		}
	};

	const handleCancelNewWorktree = () => {
		handleReturnToMenu();
	};

	const handleDeleteWorktrees = async (worktreePaths: string[]) => {
		setView('deleting-worktree');
		setError(null);

		// Delete the worktrees
		let hasError = false;
		for (const path of worktreePaths) {
			const result = worktreeService.deleteWorktree(path);
			if (!result.success) {
				hasError = true;
				setError(result.error || 'Failed to delete worktree');
				break;
			}
		}

		if (!hasError) {
			// Success - return to menu
			handleReturnToMenu();
		} else {
			// Show error
			setView('delete-worktree');
		}
	};

	const handleCancelDeleteWorktree = () => {
		handleReturnToMenu();
	};

	const handleMergeWorktree = async (
		sourceBranch: string,
		targetBranch: string,
		deleteAfterMerge: boolean,
		useRebase: boolean,
	) => {
		setView('merging-worktree');
		setError(null);

		// Perform the merge
		const mergeResult = worktreeService.mergeWorktree(
			sourceBranch,
			targetBranch,
			useRebase,
		);

		if (mergeResult.success) {
			// If user wants to delete the merged branch
			if (deleteAfterMerge) {
				const deleteResult =
					worktreeService.deleteWorktreeByBranch(sourceBranch);
				if (!deleteResult.success) {
					setError(deleteResult.error || 'Failed to delete merged worktree');
					setView('merge-worktree');
					return;
				}
			}
			// Success - return to menu
			handleReturnToMenu();
		} else {
			// Show error
			setError(mergeResult.error || 'Failed to merge branches');
			setView('merge-worktree');
		}
	};

	const handleCancelMergeWorktree = () => {
		handleReturnToMenu();
	};

	const handleCommandSelection = async (commandType: CommandType) => {
		if (!selectedWorktree) return;

		// Check if we should use Zellij
		if (isZellijAvailable && isInsideZellij) {
			// Use Zellij to create a new tab/pane
			const branchName = selectedWorktree.branch.replace('refs/heads/', '');
			const zellijResult = await ZellijService.createWorktreeTab(
				selectedWorktree.path,
				branchName,
				commandType,
			);

			if (zellijResult.success) {
				// Create a placeholder session for status tracking
				sessionManager.createSession(selectedWorktree.path, commandType, true);

				console.log(
					'Successfully created Zellij session via command selection:',
					selectedWorktree.path,
				);
				setSelectedWorktree(null);
				handleReturnToMenu();
			} else {
				console.error(
					'Failed to create Zellij session via command selection:',
					zellijResult.error,
				);
				setError(
					`Zellij integration failed: ${zellijResult.error}. Falling back to regular session.`,
				);

				// Fallback to regular session
				const session = sessionManager.createSession(
					selectedWorktree.path,
					commandType,
				);
				setActiveSession(session);
				setSelectedWorktree(null);
				setView('session');
			}
		} else {
			// Fallback to traditional session management
			const session = sessionManager.createSession(
				selectedWorktree.path,
				commandType,
			);
			setActiveSession(session);
			setSelectedWorktree(null);
			setView('session');
		}
	};

	const handleCancelCommandSelection = () => {
		handleReturnToMenu();
	};

	if (view === 'menu') {
		// Use global flag to ensure title is only rendered once
		const shouldShowTitle = !titleRendered;
		if (!titleRendered) {
			titleRendered = true;
		}

		return (
			<Box flexDirection="column">
				{shouldShowTitle && (
					<Box marginBottom={1}>
						<Text bold color="green">
							CCManager - Claude Code/Codex CLI Worktree Manager
						</Text>
					</Box>
				)}
				<Menu
					key={menuKey}
					sessionManager={sessionManager}
					onSelectWorktree={handleSelectWorktree}
					showTitle={false}
				/>
			</Box>
		);
	}

	if (view === 'session' && activeSession) {
		return (
			<Box flexDirection="column">
				<Session
					key={activeSession.id}
					session={activeSession}
					sessionManager={sessionManager}
					onReturnToMenu={handleReturnToMenu}
				/>
				<Box marginTop={1}>
					<Text dimColor>
						Press {shortcutManager.getShortcutDisplay('returnToMenu')} to return
						to menu
					</Text>
				</Box>
			</Box>
		);
	}

	if (view === 'new-worktree') {
		return (
			<Box flexDirection="column">
				{error && (
					<Box marginBottom={1}>
						<Text color="red">Error: {error}</Text>
					</Box>
				)}
				<NewWorktree
					onComplete={handleCreateWorktree}
					onCancel={handleCancelNewWorktree}
				/>
			</Box>
		);
	}

	if (view === 'creating-worktree') {
		return (
			<Box flexDirection="column">
				<Text color="green">Creating worktree...</Text>
			</Box>
		);
	}

	if (view === 'delete-worktree') {
		return (
			<Box flexDirection="column">
				{error && (
					<Box marginBottom={1}>
						<Text color="red">Error: {error}</Text>
					</Box>
				)}
				<DeleteWorktree
					onComplete={handleDeleteWorktrees}
					onCancel={handleCancelDeleteWorktree}
				/>
			</Box>
		);
	}

	if (view === 'deleting-worktree') {
		return (
			<Box flexDirection="column">
				<Text color="red">Deleting worktrees...</Text>
			</Box>
		);
	}

	if (view === 'merge-worktree') {
		return (
			<Box flexDirection="column">
				{error && (
					<Box marginBottom={1}>
						<Text color="red">Error: {error}</Text>
					</Box>
				)}
				<MergeWorktree
					onComplete={handleMergeWorktree}
					onCancel={handleCancelMergeWorktree}
				/>
			</Box>
		);
	}

	if (view === 'merging-worktree') {
		return (
			<Box flexDirection="column">
				<Text color="green">Merging worktrees...</Text>
			</Box>
		);
	}

	if (view === 'command-selection' && selectedWorktree && commandAvailability) {
		return (
			<CommandSelection
				worktreeBranch={selectedWorktree.branch.replace('refs/heads/', '')}
				commandAvailability={commandAvailability}
				onComplete={handleCommandSelection}
				onCancel={handleCancelCommandSelection}
			/>
		);
	}

	if (view === 'configuration') {
		return <Configuration onComplete={handleReturnToMenu} />;
	}

	if (view === 'no-commands-available') {
		const NoCommandsView: React.FC = () => {
			React.useEffect(() => {
				const handleKeyPress = () => {
					sessionManager.destroy();
					exit();
				};

				process.stdin.on('keypress', handleKeyPress);
				return () => {
					process.stdin.off('keypress', handleKeyPress);
				};
			}, []);

			return (
				<Box flexDirection="column">
					<Box marginBottom={1}>
						<Text bold color="red">
							No AI Coding Commands Available
						</Text>
					</Box>

					<Box marginBottom={1}>
						<Text>
							CCManager requires at least one of the following AI coding
							commands to be installed:
						</Text>
					</Box>

					<Box marginBottom={1} flexDirection="column">
						<Text>
							• <Text bold>claude</Text> - Advanced AI coding assistant
						</Text>
						<Text>
							• <Text bold>codex</Text> - Fast AI code completion
						</Text>
					</Box>

					<Box marginBottom={1}>
						<Text>
							Please install one or both commands and restart CCManager.
						</Text>
					</Box>

					<Box marginTop={1}>
						<Text dimColor>Press any key to exit...</Text>
					</Box>
				</Box>
			);
		};

		return <NoCommandsView />;
	}

	return null;
});

export default App;
