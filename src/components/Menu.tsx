import React, {useState, useEffect, useMemo} from 'react';
import {Box, Text} from 'ink';
import SelectInput from 'ink-select-input';
import {Worktree, Session} from '../types/index.js';
import {WorktreeService} from '../services/worktreeService.js';
import {SessionManager} from '../services/sessionManager.js';
import {ZellijService} from '../services/zellijService.js';
import {
	STATUS_ICONS,
	STATUS_LABELS,
	MENU_ICONS,
	getStatusDisplay,
} from '../constants/statusIcons.js';

interface MenuProps {
	sessionManager: SessionManager;
	onSelectWorktree: (worktree: Worktree) => void;
	showTitle?: boolean; // Optional prop to control title display
}

interface MenuItem {
	label: string;
	value: string;
	worktree?: Worktree;
}

const Menu: React.FC<MenuProps> = React.memo(function Menu({
	sessionManager,
	onSelectWorktree,
	showTitle = true,
}) {
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [sessions, setSessions] = useState<Session[]>([]);
	// Remove items state - will use useMemo instead
	const [isZellijAvailable, setIsZellijAvailable] = useState(false);
	const [isInsideZellij, setIsInsideZellij] = useState(false);

	// Initialize Zellij status on mount
	useEffect(() => {
		setIsZellijAvailable(ZellijService.isZellijAvailable());
		setIsInsideZellij(ZellijService.isInsideZellij());
	}, []);

	// Load worktrees on mount
	useEffect(() => {
		const worktreeService = new WorktreeService();
		const loadedWorktrees = worktreeService.getWorktrees();
		setWorktrees(loadedWorktrees);
	}, []);

	// Update sessions and listen for changes
	useEffect(() => {
		const updateSessions = () => {
			const allSessions = sessionManager.getAllSessions();
			setSessions(allSessions);
		};

		updateSessions();

		// Listen for session changes
		const handleSessionChange = () => updateSessions();
		sessionManager.on('sessionCreated', handleSessionChange);
		sessionManager.on('sessionDestroyed', handleSessionChange);
		sessionManager.on('sessionStateChanged', handleSessionChange);

		return () => {
			sessionManager.off('sessionCreated', handleSessionChange);
			sessionManager.off('sessionDestroyed', handleSessionChange);
			sessionManager.off('sessionStateChanged', handleSessionChange);
		};
	}, [sessionManager]);

	// Memoize menu items to prevent unnecessary recalculations
	const items = useMemo(() => {
		// Build menu items
		const menuItems: MenuItem[] = worktrees.map(wt => {
			const session = sessions.find(s => s.worktreePath === wt.path);
			let status = '';
			let commandPrefix = '';

			if (session) {
				const statusDisplay = session.isZellijSession
					? `Zellij-${getStatusDisplay(session.state)}`
					: getStatusDisplay(session.state);
				status = ` [${statusDisplay}]`;
				// Add command type prefix
				commandPrefix = session.commandType === 'codex' ? '[X] ' : '[C] ';
				if (session.isZellijSession) {
					// Use different icons for Claude vs Codex in Zellij
					const zellijIcon = session.commandType === 'codex' ? '🧠' : '🐦';
					commandPrefix += `${zellijIcon} `;
				}
			}

			const branchName = wt.branch.replace('refs/heads/', '');
			const isMain = wt.isMainWorktree ? ' (main)' : '';

			return {
				label: `${commandPrefix}${branchName}${isMain}${status}`,
				value: wt.path,
				worktree: wt,
			};
		});

		// Add menu options
		menuItems.push({
			label: '─────────────',
			value: 'separator',
		});
		menuItems.push({
			label: `${MENU_ICONS.NEW_WORKTREE} New Worktree`,
			value: 'new-worktree',
		});
		menuItems.push({
			label: `${MENU_ICONS.MERGE_WORKTREE} Merge Worktree`,
			value: 'merge-worktree',
		});
		menuItems.push({
			label: `${MENU_ICONS.DELETE_WORKTREE} Delete Worktree`,
			value: 'delete-worktree',
		});
		menuItems.push({
			label: `${MENU_ICONS.CONFIGURE_SHORTCUTS} Configuration`,
			value: 'configuration',
		});
		menuItems.push({
			label: `${MENU_ICONS.EXIT} Exit`,
			value: 'exit',
		});

		return menuItems;
	}, [worktrees, sessions]);

	const handleSelect = (item: MenuItem) => {
		if (item.value === 'separator') {
			// Do nothing for separator
		} else if (item.value === 'new-worktree') {
			// Handle in parent component
			onSelectWorktree({
				path: '',
				branch: '',
				isMainWorktree: false,
				hasSession: false,
			});
		} else if (item.value === 'merge-worktree') {
			// Handle in parent component - use special marker
			onSelectWorktree({
				path: 'MERGE_WORKTREE',
				branch: '',
				isMainWorktree: false,
				hasSession: false,
			});
		} else if (item.value === 'delete-worktree') {
			// Handle in parent component - use special marker
			onSelectWorktree({
				path: 'DELETE_WORKTREE',
				branch: '',
				isMainWorktree: false,
				hasSession: false,
			});
		} else if (item.value === 'configuration') {
			// Handle in parent component - use special marker
			onSelectWorktree({
				path: 'CONFIGURATION',
				branch: '',
				isMainWorktree: false,
				hasSession: false,
			});
		} else if (item.value === 'exit') {
			// Handle in parent component - use special marker
			onSelectWorktree({
				path: 'EXIT_APPLICATION',
				branch: '',
				isMainWorktree: false,
				hasSession: false,
			});
		} else if (item.worktree) {
			onSelectWorktree(item.worktree);
		}
	};

	return (
		<Box flexDirection="column">
			{showTitle && (
				<Box marginBottom={1}>
					<Text bold color="green">
						CCManager - Claude Code/Codex CLI Worktree Manager
					</Text>
				</Box>
			)}

			<Box marginBottom={1} flexDirection="column">
				<Text dimColor>
					Select a worktree to start or resume a Claude Code session:
				</Text>
				{isZellijAvailable && isInsideZellij && (
					<Text dimColor color="green">
						🏁 Zellij Mode: New sessions will open in separate tabs
					</Text>
				)}
				{isZellijAvailable && !isInsideZellij && (
					<Text dimColor color="yellow">
						⚠️ Zellij detected but not running inside session
					</Text>
				)}
				{!isZellijAvailable && (
					<Text dimColor>💡 Install Zellij for separate window sessions</Text>
				)}
			</Box>

			<SelectInput items={items} onSelect={handleSelect} isFocused={true} />

			<Box marginTop={1} flexDirection="column">
				<Text dimColor>
					Status: {STATUS_ICONS.BUSY} {STATUS_LABELS.BUSY}{' '}
					{STATUS_ICONS.WAITING} {STATUS_LABELS.WAITING} {STATUS_ICONS.IDLE}{' '}
					{STATUS_LABELS.IDLE}
				</Text>
				<Text dimColor>Commands: [C] Claude Code, [X] Codex</Text>
				<Text dimColor>Controls: ↑↓ Navigate Enter Select</Text>
			</Box>
		</Box>
	);
});

export default Menu;
