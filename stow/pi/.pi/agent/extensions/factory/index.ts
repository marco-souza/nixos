import {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface Job {
	id: string;
	feature: string;
	branch: string;
	worktree: string;
	stage: string;
	cycle: number;
	round: number;
	cycleStart: number;
	task: string | null;
	reviews: Record<string, string>;
	judge: string;
	pr: string | null;
	createdAt: string;
	updatedAt: string;
}

let currentJob: Job | null = null;
let currentJobPath: string | null = null;

function getFactoryDir(ctx: ExtensionContext): string {
	return path.join(ctx.cwd, ".factory");
}

function getJobsDir(ctx: ExtensionContext): string {
	return path.join(getFactoryDir(ctx), "jobs");
}

function getJobDir(ctx: ExtensionContext, jobId: string): string {
	return path.join(getJobsDir(ctx), jobId);
}

function getJobFile(ctx: ExtensionContext, jobId: string): string {
	return path.join(getJobDir(ctx, jobId), "job.json");
}

function getContextFile(ctx: ExtensionContext, jobId: string): string {
	return path.join(getJobDir(ctx, jobId), "CONTEXT.md");
}

function getDashboardSource(): string {
	return path.join(path.dirname(new URL(import.meta.url).pathname), "dashboard.html");
}

function getDashboardDest(ctx: ExtensionContext): string {
	return path.join(getFactoryDir(ctx), "dashboard.html");
}

function renderWidget(job: Job): string {
	const running = job.stage === "build" || job.stage === "review" ? " ⚡" : "";
	return `● factory ${job.id} │ ${job.stage}${running}`;
}

async function ensureFactoryInit(ctx: ExtensionContext): Promise<boolean> {
	const factoryDir = getFactoryDir(ctx);
	try {
		await fs.access(factoryDir);
		return true;
	} catch {
		return false;
	}
}

async function runInit(ctx: ExtensionContext): Promise<void> {
	const factoryDir = getFactoryDir(ctx);
	const jobsDir = getJobsDir(ctx);
	const dashboardDest = getDashboardDest(ctx);
	const dashboardSrc = getDashboardSource();

	await fs.mkdir(jobsDir, { recursive: true });

	const gitExclude = path.join(ctx.cwd, ".git", "info", "exclude");
	try {
		const excludeContent = await fs.readFile(gitExclude, "utf-8");
		if (!excludeContent.includes(".factory/")) {
			await fs.appendFile(gitExclude, "\n.factory/\n");
		}
	} catch {
		// .git/info/exclude might not exist, ignore
	}

	const projectName = path.basename(ctx.cwd);
	let dashboardHtml = await fs.readFile(dashboardSrc, "utf-8");
	dashboardHtml = dashboardHtml.replace(
		'<span id="project-name" class="project-name">',
		`<span id="project-name" class="project-name">${projectName}`,
	);
	await fs.writeFile(dashboardDest, dashboardHtml);

	ctx.ui.notify(
		`Factory initialized. Run dashboard:\n  cd .factory && python3 -m http.server 8000`,
		"info",
	);
}

async function loadJob(ctx: ExtensionContext, jobId: string): Promise<Job | null> {
	const jobFile = getJobFile(ctx, jobId);
	try {
		const content = await fs.readFile(jobFile, "utf-8");
		return JSON.parse(content) as Job;
	} catch {
		return null;
	}
}

async function saveJob(ctx: ExtensionContext, job: Job): Promise<void> {
	const jobFile = getJobFile(ctx, job.id);
	job.updatedAt = new Date().toISOString();
	await fs.writeFile(jobFile, JSON.stringify(job, null, 2));
}

async function listJobIds(ctx: ExtensionContext): Promise<string[]> {
	const jobsDir = getJobsDir(ctx);
	try {
		const entries = await fs.readdir(jobsDir);
		return entries
			.filter((e) => /^\d{3}-/.test(e))
			.sort();
	} catch {
		return [];
	}
}

function nextJobId(existing: string[]): string {
	const nums = existing.map((id) => parseInt(id.slice(0, 3), 10)).filter((n) => !isNaN(n));
	const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
	return next.toString().padStart(3, "0");
}

function slugify(feature: string): string {
	return feature
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 50);
}

async function execCmd(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		const proc = spawn(args[0], args.slice(1), { cwd, shell: false });
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d) => (stdout += d.toString()));
		proc.stderr?.on("data", (d) => (stderr += d.toString()));
		proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
		proc.on("error", (err) => resolve({ stdout, stderr, code: -1, error: err }));
	});
}

async function createWorktree(ctx: ExtensionContext, jobId: string): Promise<string> {
	const worktreePath = path.join(ctx.cwd, ".factory", jobId);
	const branch = `factory/${jobId}`;

	await execCmd(ctx.cwd, "git", "fetch", "origin", "main");
	await execCmd(ctx.cwd, "git", "worktree", "add", "-b", branch, worktreePath, "origin/main");

	return worktreePath;
}

async function runSetupInWorktree(ctx: ExtensionContext, worktree: string): Promise<void> {
	const agentsMd = path.join(worktree, "AGENTS.md");
	try {
		const content = await fs.readFile(agentsMd, "utf-8");
		if (content.includes("setup") || content.includes("install")) {
			ctx.ui.notify("Worktree created. Run setup commands from AGENTS.md manually if needed.", "info");
		}
	} catch {
		// No AGENTS.md, skip
	}
}

function buildDiscovererPrompt(cwd: string, job: Job, worktree: string, round: number, feedbackFile?: string): string {
	let prompt = `Job folder: ${path.join(cwd, ".factory", "jobs", job.id)}. Worktree: ${worktree}. Branch: factory/${job.id}. Cycle ${job.cycle}. Round ${round}. Request: ${job.feature}.`;
	if (feedbackFile) {
		prompt += ` Feedback: ${feedbackFile}.`;
	}
	return prompt;
}

async function spawnSubagent(
	ctx: ExtensionContext,
	agent: string,
	task: string,
	cwd: string,
): Promise<void> {
	await ctx.callTool("subagent", {
		agent,
		task,
		cwd,
		agentScope: "both",
	});
}

async function handleStart(feature: string, ctx: ExtensionContext): Promise<void> {
	if (!(await ensureFactoryInit(ctx))) {
		ctx.ui.notify("Run /factory init first", "error");
		return;
	}

	const jobIds = await listJobIds(ctx);
	const jobId = nextJobId(jobIds) + "-" + slugify(feature);
	const worktree = await createWorktree(ctx, jobId);
	await runSetupInWorktree(ctx, worktree);

	const now = new Date().toISOString();
	currentJob = {
		id: jobId,
		feature,
		branch: `factory/${jobId}`,
		worktree,
		stage: "discovery",
		cycle: 1,
		round: 0,
		cycleStart: 1,
		task: null,
		reviews: { product: "pending", security: "pending", code: "pending", ux: "pending", ui: "pending" },
		judge: "pending",
		pr: null,
		createdAt: now,
		updatedAt: now,
	};
	currentJobPath = getJobDir(ctx, jobId);

	await fs.mkdir(currentJobPath, { recursive: true });
	await saveJob(ctx, currentJob);

	const contextFile = getContextFile(ctx, jobId);
	const agentsMd = path.join(ctx.cwd, "AGENTS.md");
	let blueprint = "";
	try {
		const content = await fs.readFile(agentsMd, "utf-8");
		const match = content.match(/## Blueprint\n([\s\S]*?)(?=\n## |\n$)/);
		if (match) blueprint = match[1].trim();
	} catch {
		// No AGENTS.md or no blueprint section
	}

	await fs.writeFile(
		contextFile,
		`# Shared Context - Job ${jobId}\n\n## Project Blueprint\n${blueprint || "(none found in AGENTS.md)"}\n\n## Spec Summary\n\n## Active Decisions\n\n## Round 1 Review Notes\n\n## Build Notes\n\n## Agent Notes\n`,
	);

	ctx.ui.setWidget("factory", () => [renderWidget(currentJob!)]);

	const prompt = buildDiscovererPrompt(ctx.cwd, currentJob, worktree, 1);
	await spawnSubagent(ctx, "factory-discoverer", prompt, worktree);
}

async function handleFeedback(jobId: string, note: string, ctx: ExtensionContext): Promise<void> {
	if (!(await ensureFactoryInit(ctx))) {
		ctx.ui.notify("Run /factory init first", "error");
		return;
	}

	const job = await loadJob(ctx, jobId);
	if (!job) {
		ctx.ui.notify(`Job ${jobId} not found`, "error");
		return;
	}

	if (job.stage !== "pr" && job.stage !== "needs-human") {
		ctx.ui.notify(`Job ${jobId} is not in pr or needs-human stage (current: ${job.stage})`, "error");
		return;
	}

	currentJob = job;
	currentJobPath = getJobDir(ctx, jobId);

	const feedbackNum = (await fs.readdir(currentJobPath)).filter((f) => f.startsWith("feedback-")).length + 1;
	const feedbackFile = `feedback-${feedbackNum}.md`;
	await fs.writeFile(
		path.join(currentJobPath, feedbackFile),
		`# Feedback ${feedbackNum}\n\n${note || "(no note)"}\n`,
	);

	currentJob.cycle += 1;
	currentJob.cycleStart = currentJob.round + 1;
	currentJob.stage = "discovery";
	currentJob.round = 0;
	currentJob.reviews = { product: "pending", security: "pending", code: "pending", ux: "pending", ui: "pending" };
	currentJob.judge = "pending";
	currentJob.task = null;

	await saveJob(ctx, currentJob);
	ctx.ui.setWidget("factory", () => [renderWidget(currentJob)]);

	const prompt = buildDiscovererPrompt(ctx.cwd, currentJob, currentJob.worktree, 1, feedbackFile);
	await spawnSubagent(ctx, "factory-discoverer", prompt, currentJob.worktree);
}

async function handleShip(jobId: string, ctx: ExtensionContext): Promise<void> {
	if (!(await ensureFactoryInit(ctx))) {
		ctx.ui.notify("Run /factory init first", "error");
		return;
	}

	const job = await loadJob(ctx, jobId);
	if (!job) {
		ctx.ui.notify(`Job ${jobId} not found`, "error");
		return;
	}

	if (job.stage !== "needs-human") {
		ctx.ui.notify(`Job ${jobId} is not in needs-human stage (current: ${job.stage})`, "error");
		return;
	}

	currentJob = job;
	currentJobPath = getJobDir(ctx, jobId);
	currentJob.stage = "ship";
	await saveJob(ctx, currentJob);
	ctx.ui.setWidget("factory", () => [renderWidget(currentJob)]);

	await spawnSubagent(ctx, "factory-shipper", `Job folder: ${currentJobPath}. Worktree: ${currentJob.worktree}. Branch: ${currentJob.branch}. Ship.`, currentJob.worktree);
}

function showDashboard(ctx: ExtensionContext): void {
	const factoryDir = getFactoryDir(ctx);
	ctx.ui.notify(`Run dashboard:\n  cd ${factoryDir} && python3 -m http.server 8000\nThen open http://localhost:8000/dashboard.html`, "info");
}

function showAgents(ctx: ExtensionContext): void {
	if (!currentJob) {
		ctx.ui.notify("No active job", "info");
		return;
	}
	const stage = currentJob.stage;
	const running = stage === "build" || stage === "review" ? " (subagents running)" : "";
	ctx.ui.notify(`Job: ${currentJob.id} | Stage: ${currentJob.stage}${running}\nWidget shows live status. No panel available.`, "info");
}

async function reconstructJobState(ctx: ExtensionContext): Promise<void> {
	const jobIds = await listJobIds(ctx);
	for (const jobId of jobIds.reverse()) {
		const job = await loadJob(ctx, jobId);
		if (job && !["discarded", "pr"].includes(job.stage)) {
			currentJob = job;
			currentJobPath = getJobDir(ctx, jobId);
			ctx.ui.setWidget("factory", () => [renderWidget(currentJob)]);
			break;
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await reconstructJobState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await reconstructJobState(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		if (!currentJob) return;
		ctx.ui.setWidget("factory", () => currentJob ? [renderWidget(currentJob)] : []);
	});

	pi.registerCommand("factory", {
		description: "Factory workflow: init, start <feature>, feedback <job-id> [note], ship <job-id>, dashboard, agents",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "start";
			const rest = parts.slice(1);

			switch (sub) {
				case "init":
					await runInit(ctx);
					break;
				case "start":
					await handleStart(rest.join(" "), ctx);
					break;
				case "feedback":
					await handleFeedback(rest[0], rest.slice(1).join(" "), ctx);
					break;
				case "ship":
					await handleShip(rest[0], ctx);
					break;
				case "dashboard":
					showDashboard(ctx);
					break;
				case "agents":
					showAgents(ctx);
					break;
				case "":
					await handleStart(args.trim(), ctx);
					break;
				default:
					ctx.ui.notify(`Unknown subcommand: ${sub}. Use: init, start, feedback, ship, dashboard, agents`, "error");
			}
		},
	});
}