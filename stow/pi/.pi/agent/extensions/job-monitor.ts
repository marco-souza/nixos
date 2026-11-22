/**
 * Job Monitor Extension - Monitor background jobs and agents
 *
 * Tracks tool executions and agent runs, displays a status widget with job count,
 * and opens a detailed TUI view on demand (press F9 or run /jobs command).
 * Includes a background job tool that runs truly async and unblocks the main chat.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, OverlayHandle, OverlayOptions, Focusable } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Types
// ============================================================================

interface Job {
	id: string;
	name: string;
	type: "tool" | "agent" | "subagent" | "background";
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	startTime: number;
	endTime?: number;
	details: JobDetails;
	output: string[];
	toolName?: string;
	toolArgs?: Record<string, unknown>;
}

interface JobDetails {
	command?: string;
	agentName?: string;
	description?: string;
	[key: string]: unknown;
}

type JobStatus = Job["status"];

const MAX_JOBS = 100;
const MAX_OUTPUT_LINES = 500;
const WIDGET_KEY = "job-monitor";
const STATUS_KEY = "job-monitor-status";

// ============================================================================
// Job Store
// ============================================================================

class JobStore {
	private jobs: Job[] = [];
	private listeners: Set<() => void> = new Set();
	private currentAgentRun: string | null = null;

	add(job: Job): void {
		this.jobs.unshift(job);
		if (this.jobs.length > MAX_JOBS) this.jobs.pop();
		this.notify();
	}

	update(id: string, updates: Partial<Job>): void {
		const job = this.jobs.find((j) => j.id === id);
		if (job) {
			Object.assign(job, updates);
			this.notify();
		}
	}

	get(id: string): Job | undefined {
		return this.jobs.find((j) => j.id === id);
	}

	getAll(): Job[] {
		return [...this.jobs];
	}

	getRunning(): Job[] {
		return this.jobs.filter((j) => j.status === "running" || j.status === "pending");
	}

	getRunningCount(): number {
		return this.getRunning().length;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	setCurrentAgentRun(id: string | null): void {
		this.currentAgentRun = id;
	}

	getCurrentAgentRun(): string | null {
		return this.currentAgentRun;
	}

	clear(): void {
		this.jobs = [];
		this.notify();
	}
}

const jobStore = new JobStore();

// ============================================================================
// Background Job Types & Functions
// ============================================================================

interface BackgroundJob extends Job {
	type: "background";
	process?: ReturnType<typeof spawn>;
	logFile: string;
	pid?: number;
}

const backgroundJobs = new Map<string, BackgroundJob>();

function createBackgroundJob(command: string, cwd: string, name?: string): BackgroundJob {
	const id = generateId();
	const jobName = name || `bg: ${command.slice(0, 40)}${command.length > 40 ? "..." : ""}`;

	// Create log file
	const logDir = path.join(os.tmpdir(), "pi-job-monitor");
	if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
	const logFile = path.join(logDir, `${id}.log`);

	const job: BackgroundJob = {
		id,
		name: jobName,
		type: "background",
		status: "pending",
		startTime: Date.now(),
		details: { command, cwd },
		output: [`[${new Date().toLocaleTimeString()}] Starting background job: ${command}`],
		logFile,
	};

	backgroundJobs.set(id, job);
	jobStore.add(job);

	// Spawn detached process
	const proc = spawn("bash", ["-c", command], {
		cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	job.process = proc;
	job.pid = proc.pid;

	// Track output
	const logStream = fs.createWriteStream(logFile, { flags: "a" });
	proc.stdout?.on("data", (data: Buffer) => {
		const text = data.toString();
		logStream.write(text);
		job.output.push(...text.split("\n").filter(Boolean).map((l) => `  ${l}`));
		if (job.output.length > MAX_OUTPUT_LINES) job.output = job.output.slice(-MAX_OUTPUT_LINES);
		jobStore.update(id, { output: job.output });
	});
	proc.stderr?.on("data", (data: Buffer) => {
		const text = data.toString();
		logStream.write(`[stderr] ${text}`);
		job.output.push(...text.split("\n").filter(Boolean).map((l) => `  ${l}`));
		if (job.output.length > MAX_OUTPUT_LINES) job.output = job.output.slice(-MAX_OUTPUT_LINES);
		jobStore.update(id, { output: job.output });
	});

	proc.on("close", (code, signal) => {
		logStream.end();
		const status = signal ? "aborted" : code === 0 ? "completed" : "failed";
		job.output.push(`[${new Date().toLocaleTimeString()}] Exited with code ${code ?? signal} (${status})`);
		jobStore.update(id, {
			status,
			endTime: Date.now(),
			output: job.output,
		});
		backgroundJobs.delete(id);
	});

	proc.on("error", (err) => {
		logStream.end();
		job.output.push(`[${new Date().toLocaleTimeString()}] Error: ${err.message}`);
		jobStore.update(id, {
			status: "failed",
			endTime: Date.now(),
			output: job.output,
		});
		backgroundJobs.delete(id);
	});

	// Update status to running
	setTimeout(() => {
		jobStore.update(id, { status: "running" });
	}, 100);

	return job;
}

function getBackgroundJob(id: string): BackgroundJob | undefined {
	return backgroundJobs.get(id);
}

function killBackgroundJob(id: string): boolean {
	const job = backgroundJobs.get(id);
	if (job?.process) {
		job.process.kill("SIGTERM");
		setTimeout(() => {
			if (job.process && !job.process.killed) job.process.kill("SIGKILL");
		}, 5000);
		return true;
	}
	return false;
}

// ============================================================================
// Utility Functions
// ============================================================================

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatDuration(start: number, end?: number): string {
	const ms = (end ?? Date.now()) - start;
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60000);
	const secs = Math.floor((ms % 60000) / 1000);
	return `${mins}m ${secs}s`;
}

function getStatusIcon(status: JobStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "⏳");
		case "running":
			return theme.fg("warning", "●");
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("muted", "⊘");
	}
}

function getStatusColor(status: JobStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return "dim";
		case "running":
			return "warning";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "aborted":
			return "muted";
	}
}

// ============================================================================
// Job List Component (Sidebar)
// ============================================================================

class JobListComponent implements Component, Focusable {
	focused = false;
	private theme: Theme;
	private selectedIndex = 0;
	private onSelect: (job: Job) => void;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(theme: Theme, onSelect: (job: Job) => void) {
		this.theme = theme;
		this.onSelect = onSelect;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
		this.invalidate();
	}

	handleInput(data: string): void {
		const jobs = jobStore.getAll();
		if (jobs.length === 0) return;

		// Vim-like navigation
		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.invalidate();
		} else if (matchesKey(data, "j") || matchesKey(data, "down")) {
			this.selectedIndex = Math.min(jobs.length - 1, this.selectedIndex + 1);
			this.invalidate();
		} else if (matchesKey(data, "h")) {
			// Switch focus to right panel (handled by parent)
		} else if (matchesKey(data, "l") || matchesKey(data, "return")) {
			const job = jobs[this.selectedIndex];
			if (job) this.onSelect(job);
		} else if (matchesKey(data, "g") || matchesKey(data, "home")) {
			this.selectedIndex = 0;
			this.invalidate();
		} else if (matchesKey(data, "G") || matchesKey(data, "end")) {
			this.selectedIndex = jobs.length - 1;
			this.invalidate();
		} else if (matchesKey(data, "q") || matchesKey(data, "escape")) {
			// Quit handled by parent
		} else if (matchesKey(data, "pageup")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 10);
			this.invalidate();
		} else if (matchesKey(data, "pagedown")) {
			this.selectedIndex = Math.min(jobs.length - 1, this.selectedIndex + 10);
			this.invalidate();
		} else if (matchesKey(data, "delete") || matchesKey(data, "backspace")) {
			// Delete job with Delete/Backspace
			const job = jobs[this.selectedIndex];
			if (job && job.type === "background") {
				killBackgroundJob(job.id);
				this.invalidate();
			}
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		this.cachedWidth = width;
		const th = this.theme;
		const jobs = jobStore.getAll();
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);

		const lines: string[] = [];

		// Header
		const runningCount = jobStore.getRunningCount();
		const title = ` Jobs ${runningCount > 0 ? `(${runningCount} running)` : ""} `;
		const titleW = visibleWidth(title);
		const leftPad = Math.floor((innerW - titleW) / 2);
		const rightPad = Math.max(0, innerW - titleW - leftPad);
		lines.push(border("╭") + th.fg("accent", title) + border(`${"─".repeat(rightPad)}╮`));

		if (jobs.length === 0) {
			lines.push(border("│") + padLine(th.fg("dim", " No jobs tracked")) + border("│"));
		} else {
			for (let i = 0; i < jobs.length; i++) {
				const job = jobs[i]!;
				const isSelected = i === this.selectedIndex;
				const icon = getStatusIcon(job.status, th);
				const name = truncateToWidth(job.name, innerW - 4, "...", true);
				const prefix = isSelected ? th.fg("accent", "▶ ") : "  ";
				const nameStyled = isSelected ? th.fg("accent", name) : name;
				const time = formatDuration(job.startTime, job.endTime);
				const timeStyled = th.fg("dim", time);
				const typeBadge = job.type === "background" ? th.fg("accent", " [BG]") : "";
				const line = `${prefix}${nameStyled}${typeBadge} ${icon} ${timeStyled}`;
				lines.push(border("│") + padLine(line) + border("│"));
			}
		}

		// Footer with key hints
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(border("│") + padLine(th.fg("dim", " ↑↓ navigate  Enter view  Del kill  Esc close")) + border("│"));
		lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));

		this.cachedLines = lines;
		return lines;
	}
}

// ============================================================================
// Job Output Component (Main Content)
// ============================================================================

class JobOutputComponent implements Component {
	private theme: Theme;
	private job: Job | null;
	private scrollOffset = 0;
	private followOutput = true;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private cachedJobId: string | null = null;
	private cachedOutputHash: string = "";

	constructor(theme: Theme, job: Job | null) {
		this.theme = theme;
		this.job = job;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
		this.invalidate();
	}

	setJob(job: Job | null): void {
		if (this.job?.id !== job?.id) {
			this.job = job;
			this.scrollOffset = 0;
			this.followOutput = true;
			this.cachedJobId = job?.id ?? null;
			this.cachedOutputHash = "";
			this.invalidate();
		} else if (job && this.followOutput) {
			// Check if output changed
			const newHash = job.output.join("\n");
			if (newHash !== this.cachedOutputHash) {
				this.cachedOutputHash = newHash;
				this.invalidate();
			}
		}
	}

	handleInput(data: string): void {
		if (!this.job) return;

		// Vim-like navigation
		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			this.followOutput = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.invalidate();
		} else if (matchesKey(data, "j") || matchesKey(data, "down")) {
			const maxScroll = Math.max(0, this.job.output.length - 1);
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			if (this.scrollOffset >= maxScroll) this.followOutput = true;
			this.invalidate();
		} else if (matchesKey(data, "h")) {
			// Switch focus to left panel (handled by parent)
		} else if (matchesKey(data, "l")) {
			// l does nothing in output panel
		} else if (matchesKey(data, "g") || matchesKey(data, "home")) {
			this.followOutput = false;
			this.scrollOffset = 0;
			this.invalidate();
		} else if (matchesKey(data, "G") || matchesKey(data, "end")) {
			this.followOutput = true;
			this.scrollOffset = Math.max(0, this.job.output.length - 1);
			this.invalidate();
		} else if (matchesKey(data, "q") || matchesKey(data, "escape")) {
			// Quit handled by parent
		} else if (matchesKey(data, "f")) {
			this.followOutput = !this.followOutput;
			if (this.followOutput) {
				this.scrollOffset = Math.max(0, this.job.output.length - 1);
			}
			this.invalidate();
		} else if (matchesKey(data, "K")) {
			// Kill background job (uppercase K to avoid conflict with vim k)
			if (this.job.type === "background") {
				killBackgroundJob(this.job.id);
				this.invalidate();
			}
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width && this.cachedJobId === this.job?.id) {
			return this.cachedLines;
		}

		this.cachedWidth = width;
		this.cachedJobId = this.job?.id ?? null;
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);

		const lines: string[] = [];

		if (!this.job) {
			lines.push(border("╭") + border("─".repeat(innerW)) + border("╮"));
			lines.push(border("│") + padLine(th.fg("dim", " Select a job from the list")) + border("│"));
			lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));
			this.cachedLines = lines;
			return lines;
		}

		const job = this.job;
		const statusIcon = getStatusIcon(job.status, th);
		const statusColor = getStatusColor(job.status, th);
		const duration = formatDuration(job.startTime, job.endTime);

		// Header
		const title = ` ${job.name} ${statusIcon} ${th.fg(statusColor, job.status.toUpperCase())} ${th.fg("dim", duration)} `;
		const titleW = visibleWidth(title);
		const leftPad = Math.floor((innerW - titleW) / 2);
		const rightPad = Math.max(0, innerW - titleW - leftPad);
		lines.push(border("╭") + th.fg("accent", title) + border(`${"─".repeat(rightPad)}╮`));

		// Tool/agent details
		if (job.type === "tool" && job.toolName) {
			const toolInfo = ` Tool: ${th.fg("accent", job.toolName)} `;
			if (job.toolArgs) {
				const argsStr = JSON.stringify(job.toolArgs).slice(0, innerW - toolInfo.length - 4);
				lines.push(border("│") + padLine(`${toolInfo}${th.fg("dim", argsStr)}`) + border("│"));
			} else {
				lines.push(border("│") + padLine(toolInfo) + border("│"));
			}
		} else if (job.type === "subagent" && job.details.agentName) {
			lines.push(border("│") + padLine(` Agent: ${th.fg("accent", String(job.details.agentName))}`) + border("│"));
		} else if (job.type === "agent") {
			lines.push(border("│") + padLine(` Agent run: ${th.fg("accent", job.details.description || "main")}`) + border("│"));
		} else if (job.type === "background") {
			lines.push(border("│") + padLine(` ${th.fg("accent", "Background Job")}  PID: ${th.fg("dim", String(job.pid ?? "?"))}`) + border("│"));
		}

		if (job.details.command) {
			const cmd = truncateToWidth(job.details.command, innerW - 10, "...", true);
			lines.push(border("│") + padLine(` ${th.fg("muted", "$")} ${th.fg("toolOutput", cmd)}`) + border("│"));
		}
		if (job.details.cwd) {
			const cwd = truncateToWidth(job.details.cwd, innerW - 8, "...", true);
			lines.push(border("│") + padLine(` ${th.fg("dim", "cwd:")} ${cwd}`) + border("│"));
		}

		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		// Output content
		const output = job.output.slice(-MAX_OUTPUT_LINES);
		const maxVisibleLines = Math.max(1, 30); // Reserve space for header/footer

		let visibleOutput: string[];
		if (this.followOutput) {
			this.scrollOffset = Math.max(0, output.length - maxVisibleLines);
			visibleOutput = output.slice(this.scrollOffset);
		} else {
			visibleOutput = output.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);
		}

		for (const line of visibleOutput) {
			lines.push(border("│") + padLine(` ${line}`) + border("│"));
		}

		// Pad remaining space
		const usedLines = lines.length;
		const remainingLines = maxVisibleLines - visibleOutput.length;
		for (let i = 0; i < remainingLines; i++) {
			lines.push(border("│") + padLine("") + border("│"));
		}

		// Footer
		const followStatus = this.followOutput ? th.fg("success", "● FOLLOW") : th.fg("dim", "○ PAUSED");
		const lineInfo = th.fg("dim", `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + visibleOutput.length, output.length)} of ${output.length}`);
		const killHint = job.type === "background" && job.status === "running" ? th.fg("error", "  K kill ") : "";
		const footerLeft = `${followStatus}  ${lineInfo}${killHint}`;
		const footerRight = th.fg("dim", " ↑↓ scroll  F follow  Home/End  K kill  Esc close ");
		const footerContent = `${footerLeft}${" ".repeat(Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight)))}${footerRight}`;
		lines.push(border("│") + padLine(footerContent) + border("│"));
		lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));

		this.cachedLines = lines;
		return lines;
	}
}

// ============================================================================
// Job Monitor Overlay Component (Main Custom UI)
// ============================================================================

class JobMonitorOverlay implements Component {
	private theme: Theme;
	private tui: TUI;
	private done: () => void;
	private jobList: JobListComponent;
	private jobOutput: JobOutputComponent;
	private selectedJob: Job | null = null;
	private focusLeft = true; // true = list, false = output
	private unsubscribeStore: () => void;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;

		this.jobList = new JobListComponent(theme, (job) => {
			this.selectedJob = job;
			this.jobOutput.setJob(job);
			this.focusLeft = false;
			this.invalidate();
			this.tui.requestRender();
		});

		this.jobOutput = new JobOutputComponent(theme, null);

		this.unsubscribeStore = jobStore.subscribe(() => {
			this.invalidate();
			this.tui.requestRender();
		});

		// Select first job if available
		const jobs = jobStore.getAll();
		if (jobs.length > 0) {
			this.selectedJob = jobs[0];
			this.jobOutput.setJob(jobs[0]);
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.jobList.invalidate();
		this.jobOutput.invalidate();
	}

	dispose(): void {
		this.unsubscribeStore();
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
		this.jobList.setTheme(theme);
		this.jobOutput.setTheme(theme);
		this.invalidate();
	}

	handleInput(data: string): void {
		// Global keys
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.done();
			return;
		}

		// Vim-like focus switching
		if (matchesKey(data, "h")) {
			if (!this.focusLeft) {
				this.focusLeft = true;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "l") || matchesKey(data, "tab")) {
			if (this.focusLeft) {
				this.focusLeft = false;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// Delegate to focused panel
		if (this.focusLeft) {
			this.jobList.handleInput(data);
		} else {
			this.jobOutput.handleInput(data);
		}
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		this.cachedWidth = width;
		const th = this.theme;
		const leftWidth = Math.max(30, Math.floor(width * 0.3));
		const rightWidth = Math.max(40, width - leftWidth - 1); // -1 for separator

		const leftLines = this.jobList.render(leftWidth);
		const rightLines = this.jobOutput.render(rightWidth);

		const maxLines = Math.max(leftLines.length, rightLines.length);
		const lines: string[] = [];

		for (let i = 0; i < maxLines; i++) {
			const left = i < leftLines.length ? leftLines[i] : " ".repeat(leftWidth);
			const right = i < rightLines.length ? rightLines[i] : " ".repeat(rightWidth);
			const separator = i === 0 ? th.fg("accent", "┬") : i === maxLines - 1 ? th.fg("accent", "┴") : th.fg("border", "│");
			const focusIndicator = this.focusLeft
				? i === 0
					? th.fg("accent", "◀")
					: " "
				: i === 0
					? th.fg("accent", "▶")
					: " ";
			lines.push(`${left}${separator}${focusIndicator}${right}`);
		}

		this.cachedLines = lines;
		return lines;
	}
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
	let overlayHandle: OverlayHandle | null = null;

	// Track tool executions
	pi.on("tool_execution_start", async (event, ctx) => {
		const { toolCallId, toolName, args } = event;

		// Skip tracking for certain tools
		const skipTools = ["read", "write", "edit", "ls", "find", "grep", "glob", "todo", "task"];
		if (skipTools.includes(toolName)) return;

		let name = toolName;
		let description = "";
		let command = "";

		if (toolName === "bash") {
			name = "bash";
			command = (args as { command?: string }).command ?? "";
			description = command.length > 60 ? `${command.slice(0, 60)}...` : command;
		} else if (toolName === "subagent") {
			name = "subagent";
			const agentName = (args as { agent?: string }).agent;
			const task = (args as { task?: string }).task;
			description = agentName ? `${agentName}: ${task?.slice(0, 50) ?? ""}` : "subagent";
		}

		const job: Job = {
			id: toolCallId,
			name: description || name,
			type: toolName === "subagent" ? "subagent" : "tool",
			status: "running",
			startTime: Date.now(),
			details: { command, agentName: (args as { agent?: string }).agent },
			output: [`[${new Date().toLocaleTimeString()}] Started: ${name}`],
			toolName,
			toolArgs: args,
		};

		jobStore.add(job);
		updateWidget(ctx);
		updateStatus(ctx);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		const { toolCallId, partialResult } = event;
		const job = jobStore.get(toolCallId);
		if (job && partialResult) {
			const output = typeof partialResult === "string" ? partialResult : JSON.stringify(partialResult);
			job.output.push(`[${new Date().toLocaleTimeString()}] ${output}`);
			if (job.output.length > MAX_OUTPUT_LINES) job.output.shift();
			jobStore.update(toolCallId, { output: job.output });
			updateWidget(ctx);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const { toolCallId, toolName, result, isError, durationMs } = event;
		const job = jobStore.get(toolCallId);
		if (!job) return;

		const status: JobStatus = isError ? "failed" : "completed";
		const endTime = Date.now();

		let outputText = "";
		if (result) {
			// Handle different result formats
			if (Array.isArray(result.content)) {
				for (const item of result.content) {
					if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
						outputText += item.text;
					}
				}
			} else if (typeof result === "string") {
				outputText = result;
			} else if (result.text && typeof result.text === "string") {
				outputText = result.text;
			}
		}

		job.output.push(`[${new Date().toLocaleTimeString()}] ${status.toUpperCase()} (${durationMs ?? 0}ms)`);
		if (outputText) {
			for (const line of outputText.split("\n")) {
				if (line.trim()) job.output.push(`  ${line}`);
			}
		}
		if (job.output.length > MAX_OUTPUT_LINES) job.output.shift();

		jobStore.update(toolCallId, {
			status,
			endTime,
			output: job.output,
		});
		updateWidget(ctx);
		updateStatus(ctx);
	});

	// Track agent runs
	pi.on("agent_start", async (_event, ctx) => {
		const runId = `agent-${Date.now()}`;
		jobStore.setCurrentAgentRun(runId);

		const job: Job = {
			id: runId,
			name: "Agent Run",
			type: "agent",
			status: "running",
			startTime: Date.now(),
			details: { description: "main" },
			output: [`[${new Date().toLocaleTimeString()}] Agent run started`],
		};

		jobStore.add(job);
		updateWidget(ctx);
		updateStatus(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		const runId = jobStore.getCurrentAgentRun();
		if (!runId) return;

		const job = jobStore.get(runId);
		if (!job) return;

		const hasMoreWork = event.messages.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"));

		job.output.push(`[${new Date().toLocaleTimeString()}] Agent turn ended${hasMoreWork ? " (continuing...)" : ""}`);
		if (job.output.length > MAX_OUTPUT_LINES) job.output.shift();

		if (!hasMoreWork) {
			jobStore.update(runId, {
				status: "completed",
				endTime: Date.now(),
				output: job.output,
			});
			jobStore.setCurrentAgentRun(null);
		} else {
			jobStore.update(runId, { output: job.output });
		}
		updateWidget(ctx);
		updateStatus(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const runId = jobStore.getCurrentAgentRun();
		if (!runId) return;

		const job = jobStore.get(runId);
		if (!job) return;

		job.output.push(`[${new Date().toLocaleTimeString()}] Agent settled`);
		if (job.output.length > MAX_OUTPUT_LINES) job.output.shift();

		jobStore.update(runId, {
			status: "completed",
			endTime: Date.now(),
			output: job.output,
		});
		jobStore.setCurrentAgentRun(null);
		updateWidget(ctx);
		updateStatus(ctx);
	});

	// Session lifecycle
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		updateWidget(ctx);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (overlayHandle) {
			overlayHandle.hide();
			overlayHandle = null;
		}
		jobStore.clear();
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	// Register background job tool
	const BackgroundJobParams = Type.Object({
		command: Type.String({ description: "Command to run in background" }),
		cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
		name: Type.Optional(Type.String({ description: "Optional name for the job" })),
	});

	pi.registerTool({
		name: "bgjob",
		label: "Background Job",
		description: "Run a command in the background without blocking the main chat. Returns immediately with a job ID. Use /jobs or F9 to monitor.",
		parameters: BackgroundJobParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const job = createBackgroundJob(params.command, params.cwd ?? ctx.cwd, params.name);
			return {
				content: [
					{
						type: "text",
						text: `Background job started: ${job.name}\nJob ID: ${job.id}\nPID: ${job.pid}\n\nUse /jobs or press F9 to monitor output. The main chat continues immediately.`,
					},
				],
				details: { jobId: job.id, pid: job.pid },
			};
		},
		renderCall(args, theme) {
			const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}...` : args.command;
			return new Text(
				theme.fg("toolTitle", theme.bold("bgjob ")) +
				theme.fg("accent", preview) +
				theme.fg("dim", ` [${args.cwd ?? "cwd"}]`),
				0,
				0,
			);
		},
	});

	// Register command to open job monitor
	pi.registerCommand("jobs", {
		description: "Open job monitor (background jobs and agents)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Job monitor requires interactive TUI mode", "error");
				return;
			}
			openJobMonitor(ctx);
		},
	});

	// Register command to clear job history
	pi.registerCommand("jobs:clear", {
		description: "Clear job monitor history",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			jobStore.clear();
			if (ctx.hasUI) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
			ctx.ui.notify("Job history cleared", "info");
		},
	});

	// Register keybinding (F9) to toggle job monitor
	pi.registerShortcut("f9", {
		description: "Toggle job monitor",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;
			if (overlayHandle) {
				overlayHandle.hide();
				overlayHandle = null;
			} else {
				await openJobMonitor(ctx);
			}
		},
	});

	// Also register Ctrl+Shift+J as alternative
	pi.registerShortcut("ctrl+shift+j", {
		description: "Open job monitor",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;
			if (!overlayHandle) {
				await openJobMonitor(ctx);
			}
		},
	});

	async function openJobMonitor(ctx: ExtensionCommandContext): Promise<void> {
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const component = new JobMonitorOverlay(tui, theme, () => {
				overlayHandle = null;
				done();
			});
			return component;
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "90%",
				maxHeight: "90%",
				margin: 1,
			},
			blocked: { kind: "question", message: "Job Monitor" },
			onHandle: (handle) => {
				overlayHandle = handle;
			},
		});
	}

	function updateWidget(ctx: ExtensionCommandContext): void {
		if (!ctx.hasUI) return;
		const runningCount = jobStore.getRunningCount();
		const totalCount = jobStore.getAll().length;

		if (runningCount === 0 && totalCount === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		// Only show hint - running count is in status bar
		ctx.ui.setWidget(WIDGET_KEY, ["Press F9 or /jobs to open monitor"], { placement: "aboveEditor" });
	}

	function updateStatus(ctx: ExtensionCommandContext): void {
		if (!ctx.hasUI) return;
		const runningCount = jobStore.getRunningCount();
		if (runningCount > 0) {
			ctx.ui.setStatus(STATUS_KEY, `⚡ ${runningCount} jobs running`);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}
}