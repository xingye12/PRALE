/**
 * regression.mjs — extension-trust/retransfer
 *
 * Fault: DefaultResourceLoader.reload() resolved project trust and then forced the
 * settings manager to the trusted state regardless of the answer, so a *denied*
 * decision (and every later fresh reload that inherited the session trust state)
 * behaved like an approval: project-local extensions/skills/prompts/themes and the
 * project SYSTEM.md became active.
 *
 * This script drives the real `DefaultResourceLoader` from
 * packages/coding-agent/src/core/resource-loader.ts through the same phases main.ts
 * uses (bootstrap pass -> trust resolution -> final load -> fresh reload) with
 * boundary fakes for the filesystem-independent collaborators. It asserts the
 * required phase separation:
 *
 *   bootstrap        : project resources absent, user/global + CLI available
 *   decision false   : project resources absent, user/global + CLI available
 *   fresh reload     : still untrusted, project resources still absent
 *   decision true    : project resources available
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolveNative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule } from "./subject.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolveNative(here, "..");
const stageDir = join(here, ".tmp-retransfer");

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const projectDir = join(stageDir, "project");
const agentDir = join(stageDir, "agent");
const cliDir = join(stageDir, "cli");

const userExtensionPath = join(agentDir, "extensions", "user.ts");
const projectExtensionPath = join(projectDir, ".pi", "extensions", "project.ts");
const cliExtensionPath = join(cliDir, "cli-extension.ts");
const userSkillPath = join(agentDir, "skills", "user-skill");
const projectSkillPath = join(projectDir, ".pi", "skills", "project-skill");
const userPromptPath = join(agentDir, "prompts", "user-prompt.md");
const projectPromptPath = join(projectDir, ".pi", "prompts", "project-prompt.md");
const projectThemePath = join(projectDir, ".pi", "themes", "project-theme.json");
const projectSystemPromptPath = join(projectDir, ".pi", "SYSTEM.md");
const globalSystemPromptPath = join(agentDir, "SYSTEM.md");

const GLOBAL_SYSTEM_PROMPT = "Global system prompt.";
const PROJECT_SYSTEM_PROMPT = "Project system prompt.";

function writeFixture(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

// Real files: the loader itself stats/reads system prompts, themes and CLI
// extension paths from disk, so the fixtures must exist.
writeFixture(userExtensionPath, "export default function () {}\n");
writeFixture(projectExtensionPath, "export default function () {}\n");
writeFixture(cliExtensionPath, "export default function () {}\n");
writeFixture(join(userSkillPath, "SKILL.md"), "---\nname: user-skill\ndescription: user\n---\nuser\n");
writeFixture(join(projectSkillPath, "SKILL.md"), "---\nname: project-skill\ndescription: project\n---\nproject\n");
writeFixture(userPromptPath, "user prompt\n");
writeFixture(projectPromptPath, "project prompt\n");
writeFixture(projectThemePath, JSON.stringify({ name: "project-theme" }, null, 2));
writeFixture(projectSystemPromptPath, PROJECT_SYSTEM_PROMPT);
writeFixture(globalSystemPromptPath, GLOBAL_SYSTEM_PROMPT);

const metadata = (scope, baseDir) => ({ source: "auto", scope, origin: "top-level", baseDir });

/** Boundary fakes for the collaborators DefaultResourceLoader imports. */
function createBindings() {
	const trust = { trusted: false };
	const trustTransitions = [];

	const settingsManager = {
		async reload() {},
		isProjectTrusted() {
			return trust.trusted;
		},
		setProjectTrusted(next) {
			// Mirrors SettingsManager.setProjectTrusted: a no-op when unchanged.
			if (trust.trusted === next) return;
			trust.trusted = next;
			trustTransitions.push(next);
		},
	};

	const toExtension = (path) => ({
		path,
		resolvedPath: resolveNative(path),
		commands: new Map(),
		tools: new Map(),
		flags: new Map(),
	});

	const loadExtensionsCached = async (paths, _cwd, _eventBus, runtime) => ({
		extensions: paths.map(toExtension),
		errors: [],
		warnings: [],
		runtime: runtime ?? { fake: true },
	});

	const userExtension = { path: userExtensionPath, enabled: true, metadata: metadata("user", agentDir) };
	const projectExtension = { path: projectExtensionPath, enabled: true, metadata: metadata("project", projectDir) };
	const userSkill = { path: userSkillPath, enabled: true, metadata: metadata("user", join(agentDir, "skills")) };
	const projectSkill = { path: projectSkillPath, enabled: true, metadata: metadata("project", join(projectDir, ".pi")) };
	const userPrompt = { path: userPromptPath, enabled: true, metadata: metadata("user", join(agentDir, "prompts")) };
	const projectPrompt = {
		path: projectPromptPath,
		enabled: true,
		metadata: metadata("project", join(projectDir, ".pi")),
	};
	const projectTheme = {
		path: projectThemePath,
		enabled: true,
		metadata: metadata("project", join(projectDir, ".pi")),
	};

	const resolveCalls = [];

	/** Mirrors DefaultPackageManager: project resources only when project is trusted. */
	class FakePackageManager {
		constructor(options) {
			this.options = options;
		}

		async resolve() {
			const trusted = this.options.settingsManager.isProjectTrusted();
			resolveCalls.push(trusted);
			return {
				extensions: trusted ? [projectExtension, userExtension] : [userExtension],
				skills: trusted ? [projectSkill, userSkill] : [userSkill],
				prompts: trusted ? [projectPrompt, userPrompt] : [userPrompt],
				themes: trusted ? [projectTheme] : [],
			};
		}

		async resolveExtensionSources(paths) {
			return {
				extensions: paths.map((path) => ({
					path,
					enabled: true,
					metadata: { source: "cli", scope: "temporary", origin: "top-level" },
				})),
				skills: [],
				prompts: [],
				themes: [],
				diagnostics: [],
			};
		}
	}

	const bindings = {
		CONFIG_DIR_NAME: ".pi",
		resolvePath(input, baseDir = root, options = {}) {
			const normalized = options.trim ? String(input).trim() : String(input);
			return isAbsolute(normalized) ? resolveNative(normalized) : resolveNative(baseDir, normalized);
		},
		canonicalizePath(value) {
			try {
				return realpathSync(value);
			} catch {
				return value;
			}
		},
		isLocalPath(value) {
			const trimmed = String(value).trim();
			return !["npm:", "git:", "github:", "http:", "https:", "ssh:"].some((prefix) =>
				trimmed.startsWith(prefix),
			);
		},
		stripBom: (text) => String(text).replace(/^\uFEFF/, ""),
		createEventBus: () => ({ emit() {}, on: () => () => {}, off() {} }),
		clearExtensionCache: () => {},
		createExtensionRuntime: () => ({ fake: true }),
		loadExtensionsCached,
		loadExtensionFromFactory: async (_factory, _cwd, _eventBus, _runtime, extensionPath) =>
			toExtension(extensionPath),
		findGitPaths: () => undefined,
		createSourceInfo: (path, meta) => ({
			path,
			source: meta.source,
			scope: meta.scope,
			origin: meta.origin,
			baseDir: meta.baseDir,
		}),
		resetTimings: () => {},
		DefaultPackageManager: FakePackageManager,
		SettingsManager: class {
			static create() {
				throw new Error("regression must inject its own settings manager");
			}
		},
		loadSkills: ({ skillPaths }) => ({
			skills: skillPaths.map((path) => ({
				// Skill names come from the skill directory, like the real loader's frontmatter.
				name: basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path),
				filePath: path,
			})),
			diagnostics: [],
		}),
		loadPromptTemplates: ({ promptPaths }) => ({
			templates: promptPaths.map((path) => ({ name: basename(path, ".md"), filePath: path })),
			diagnostics: [],
		}),
		loadThemeFromPath: (filePath) => ({ name: basename(filePath, ".json"), sourcePath: filePath }),
	};

	return { bindings, settingsManager, trust, trustTransitions, resolveCalls };
}

const pathsOf = (entries) => Array.from(entries, (entry) => entry.path ?? entry.filePath);
const namesOf = (entries) => Array.from(entries, (entry) => entry.name);

const { DefaultResourceLoader } = await loadModule(
	root,
	"packages/coding-agent/src/core/resource-loader.ts",
	createBindings().bindings,
);

async function scenario() {
	const fakes = createBindings();
	const { settingsManager, trust, trustTransitions } = fakes;
	const loader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [cliExtensionPath],
	});
	return { loader, settingsManager, trust, trustTransitions };
}

// ---------------------------------------------------------------------------
// Phase 1 + 2: bootstrap pass, then a denied trust decision.
// ---------------------------------------------------------------------------
{
	const { loader, settingsManager, trustTransitions } = await scenario();
	let bootstrapSnapshot;
	let bootstrapTrusted;

	assert.equal(settingsManager.isProjectTrusted(), false, "fresh loader must start untrusted");

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapTrusted = settingsManager.isProjectTrusted();
			bootstrapSnapshot = pathsOf(extensionsResult.extensions);
			return false;
		},
	});

	// Bootstrap pass: project resources are absent, user/global + CLI are available.
	assert.equal(bootstrapTrusted, false, "bootstrap pass must run with the project untrusted");
	assert.deepEqual(
		bootstrapSnapshot,
		[cliExtensionPath, userExtensionPath],
		`bootstrap must load only CLI and user extensions, got ${JSON.stringify(bootstrapSnapshot)}`,
	);

	// Denied decision: still untrusted, project resources still absent.
	assert.equal(
		settingsManager.isProjectTrusted(),
		false,
		"a denied trust decision must leave the project untrusted (the loader must apply the resolved answer, not approval)",
	);
	assert.deepEqual(trustTransitions, [], "resolving trust to false must not transition the project to trusted");

	assert.deepEqual(
		pathsOf(loader.getExtensions().extensions),
		[cliExtensionPath, userExtensionPath],
		"project extension must stay out after the trust decision is false",
	);
	assert.deepEqual(namesOf(loader.getSkills().skills), ["user-skill"], "project skill must stay out after false");
	assert.deepEqual(namesOf(loader.getPrompts().prompts), ["user-prompt"], "project prompt must stay out after false");
	assert.deepEqual(namesOf(loader.getThemes().themes), [], "project theme must stay out after false");
	assert.equal(loader.getSystemPrompt(), GLOBAL_SYSTEM_PROMPT, "project SYSTEM.md must stay out after false");
	assert.equal(
		loader.getSystemPromptSource()?.path,
		globalSystemPromptPath,
		"untrusted runs must report the global SYSTEM.md as the prompt source",
	);

	// -----------------------------------------------------------------------
	// Phase 3: a fresh resource reload inherits the denied decision.
	// -----------------------------------------------------------------------
	await loader.reload();

	assert.equal(
		settingsManager.isProjectTrusted(),
		false,
		"a fresh reload after a denied decision must not treat the project as approved",
	);
	assert.deepEqual(
		pathsOf(loader.getExtensions().extensions),
		[cliExtensionPath, userExtensionPath],
		"fresh reload after false must not load project extensions",
	);
	assert.deepEqual(namesOf(loader.getSkills().skills), ["user-skill"], "fresh reload after false keeps skills gated");
	assert.deepEqual(namesOf(loader.getPrompts().prompts), ["user-prompt"], "fresh reload after false keeps prompts gated");
	assert.deepEqual(namesOf(loader.getThemes().themes), [], "fresh reload after false keeps themes gated");
	assert.equal(loader.getSystemPrompt(), GLOBAL_SYSTEM_PROMPT, "fresh reload after false keeps SYSTEM.md gated");
	assert.deepEqual(
		pathsOf(loader.getExtensions().extensions).includes(cliExtensionPath),
		true,
		"CLI extensions stay available after false",
	);
}

// ---------------------------------------------------------------------------
// Phase 4: an approved trust decision activates project resources.
// ---------------------------------------------------------------------------
{
	const { loader, settingsManager } = await scenario();
	let bootstrapSnapshot;

	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			bootstrapSnapshot = pathsOf(extensionsResult.extensions);
			return true;
		},
	});

	assert.deepEqual(
		bootstrapSnapshot,
		[cliExtensionPath, userExtensionPath],
		"bootstrap must still hide project extensions when trust is later approved",
	);
	assert.equal(settingsManager.isProjectTrusted(), true, "an approved decision must mark the project trusted");
	assert.deepEqual(
		pathsOf(loader.getExtensions().extensions),
		[cliExtensionPath, projectExtensionPath, userExtensionPath],
		"approval must activate the project extension alongside CLI and user extensions",
	);
	assert.deepEqual(namesOf(loader.getSkills().skills).sort(), ["project-skill", "user-skill"]);
	assert.deepEqual(namesOf(loader.getPrompts().prompts).sort(), ["project-prompt", "user-prompt"]);
	assert.deepEqual(namesOf(loader.getThemes().themes), ["project-theme"]);
	assert.equal(loader.getSystemPrompt(), PROJECT_SYSTEM_PROMPT, "approval must activate the project SYSTEM.md");
	assert.equal(
		loader.getSystemPromptSource()?.path,
		projectSystemPromptPath,
		"trusted runs must report the project SYSTEM.md as the prompt source",
	);
}

rmSync(stageDir, { recursive: true, force: true });
console.log("regression: trust phase separation preserved (bootstrap hidden, false hidden, true visible)");
