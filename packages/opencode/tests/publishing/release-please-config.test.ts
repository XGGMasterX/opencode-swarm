import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Repo root relative to this test file: packages/opencode/tests/publishing/
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'release-please-config.json');

// The reviewed bootstrap bound: the last BREAKING CHANGE commit on `next`
// (98b020168 "feat!: extract core into monorepo..."). release-please's
// bootstrap walk stops EXCLUSIVELY at this sha (manifest.js breaks before
// collecting it), so every breaking commit is excluded from the sweep while
// the packages/telemetry fix commits (376b12730, 6fdebce18) stay in range.
// A bound at the March tip 23f051f1 strands telemetry (no packages/telemetry
// commits in (23f051f1, HEAD]); an earlier bound re-includes the breaking
// commits and re-proposes 9.0.0-beta.0 (issue #3173's misfire).
const REQUIRED_BOOTSTRAP_SHA = '98b020168298679467bce6d5d20ce1fbdf62c06b';
// Explicit path -> component mapping (not just a set): a swapped pair would
// pass a set assertion while rendering misattributed tags
// (e.g. core released as telemetry-v8.0.2-beta.0).
const EXPECTED_COMPONENT_BY_PATH: Record<string, string> = {
	'packages/opencode': 'opencode',
	'packages/core': 'core',
	'packages/claude-code': 'claude-code',
	'packages/telemetry': 'telemetry',
};
// Dead config keys: `branches` is consumed by nothing (release-please@16/17
// read root keys only); `changelog-notes-type` is not a release-please key at
// all (the schema key is `changelog-type`) and is silently ignored.
const DEAD_ROOT_KEYS = ['branches', 'changelog-notes-type'];

function loadConfig(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) {
		throw new Error(`release-please-config.json not found at ${CONFIG_PATH}`);
	}
	return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function gitExitCode(args: string[]): number | undefined {
	// NOTE: Bun.spawnSync THROWS (ENOENT) when the binary is absent; a throw
	// here is a real environment failure, not a skip condition.
	return Bun.spawnSync(['git', '-C', REPO_ROOT, ...args], { stdout: 'ignore', stderr: 'ignore' }).exitCode;
}

describe('release-please config (issue #3150 release enablement)', () => {
	test('root bootstrap-sha is pinned to the reviewed bound', () => {
		const cfg = loadConfig();
		expect(cfg['bootstrap-sha']).toBe(REQUIRED_BOOTSTRAP_SHA);
	});

	test('no dead root-level config keys', () => {
		// release-please@16/17 and the pinned action read only root-level keys
		// (a `branches` array is silently ignored), and `changelog-notes-type`
		// is not a release-please key at all (the schema key is
		// `changelog-type`) - both would mislead readers into thinking the
		// next line is configured as written.
		const cfg = loadConfig();
		for (const key of DEAD_ROOT_KEYS) {
			expect(key in cfg, `dead root-level key "${key}" must not return`).toBe(false);
		}
	});

	test('per-component tags: include-component-in-tag is true, every package maps to its exact component, and no package overrides the flag', () => {
		const cfg = loadConfig();
		// With include-component-in-tag false, strategies/base.js blanks the
		// component: linked-versions can never match and every package shares
		// the collision-prone bare `v<version>` tag namespace (a drifted
		// monorepo then collides tags across version lines). release-please
		// honors a PER-PATH override of this key (manifest.js:
		// `pathConfig.includeComponentInTag ?? defaultConfig`), so a package
		// entry must not be able to silently restore the bare namespace.
		expect(cfg['include-component-in-tag']).toBe(true);
		const packages = (cfg['packages'] ?? {}) as Record<string, Record<string, unknown>>;
		for (const [pkgPath, expectedComponent] of Object.entries(EXPECTED_COMPONENT_BY_PATH)) {
			const entry = packages[pkgPath];
			expect(entry, `${pkgPath} must be present in packages`).toBeTypeOf('object');
			expect(entry['component'], `${pkgPath} component must be exactly "${expectedComponent}"`).toBe(expectedComponent);
			expect(
				'include-component-in-tag' in entry,
				`${pkgPath} must not override include-component-in-tag (would silently restore the shared tag namespace)`,
			).toBe(false);
		}
		expect(Object.keys(packages).sort()).toEqual(Object.keys(EXPECTED_COMPONENT_BY_PATH).sort());
	});

	test('linked-versions lockstep group covers exactly the configured components', () => {
		const cfg = loadConfig();
		const plugins = (cfg['plugins'] ?? []) as Array<unknown>;
		const types = plugins.map((p) => (typeof p === 'object' && p !== null ? (p as Record<string, unknown>)['type'] : p));
		expect(types).toContain('node-workspace');
		const linked = plugins.filter(
			(p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['type'] === 'linked-versions',
		);
		expect(linked.length).toBe(1);
		const group = linked[0] as Record<string, unknown>;
		expect(group['groupName']).toBeTypeOf('string');
		expect((group['groupName'] as string).length).toBeGreaterThan(0);
		const expectedComponents = Object.values(EXPECTED_COMPONENT_BY_PATH).sort();
		expect([...((group['components'] ?? []) as string[])].sort()).toEqual(expectedComponents);
	});

	// History-dependent leg. CI's actions/checkout is shallow (depth 1) by
	// default and cannot resolve the anchor, so the leg degrades there — but
	// the two failure shapes are distinguished: a SHALLOW clone skips honestly,
	// while a FULL clone that cannot resolve the anchor (bogus/rewritten sha)
	// FAILS. On full clones it additionally proves the two properties that
	// make the bound correct: no BREAKING CHANGE commit after it, and every
	// package has at least one commit after it (no stranded package).
	test('bootstrap-sha is the last breaking commit and covers every package (honest skip on shallow checkouts)', () => {
		const shallow = Bun.spawnSync(['git', '-C', REPO_ROOT, 'rev-parse', '--is-shallow-repository'], {
			stdout: 'pipe',
			stderr: 'ignore',
		});
		if (shallow.exitCode === 0 && shallow.stdout.toString().trim() === 'true') {
			console.log(`skip: shallow checkout cannot verify the ancestry of ${REQUIRED_BOOTSTRAP_SHA.slice(0, 8)} - run in a full clone to exercise this leg`);
			return;
		}
		expect(gitExitCode(['cat-file', '-e', `${REQUIRED_BOOTSTRAP_SHA}^{commit}`]), 'bootstrap-sha must resolve in a full clone (bogus/rewritten sha is a config defect)').toBe(0);
		expect(gitExitCode(['merge-base', '--is-ancestor', REQUIRED_BOOTSTRAP_SHA, 'HEAD']), 'bootstrap-sha must be an ancestor of HEAD').toBe(0);
		// No BREAKING CHANGE commit may exist after the bound: one would force
		// a major bump back onto the 9.0.0-beta.0 misfire path. Conventional
		// commits express breaking two ways - a `BREAKING CHANGE:` TRAILER
		// (parsed by git trailers, immune to prose mentions in commit bodies)
		// or a `!` before the colon in the subject's type position.
		const trailers = Bun.spawnSync(
			['git', '-C', REPO_ROOT, 'log', '--format=%H|%-(trailers:key=BREAKING CHANGE,valueonly)', `${REQUIRED_BOOTSTRAP_SHA}..HEAD`],
			{ stdout: 'pipe', stderr: 'ignore' },
		);
		expect(trailers.exitCode).toBe(0);
		const trailerBreaking = trailers.stdout.toString().split('\n').filter((line) => {
			const value = line.slice(line.indexOf('|') + 1).trim();
			return line.includes('|') && value !== '';
		});
		expect(trailerBreaking, `commits with a BREAKING CHANGE trailer after the bound: ${trailerBreaking.join('; ')}`).toEqual([]);
		const subjects = Bun.spawnSync(['git', '-C', REPO_ROOT, 'log', '--format=%s', `${REQUIRED_BOOTSTRAP_SHA}..HEAD`], {
			stdout: 'pipe',
			stderr: 'ignore',
		});
		expect(subjects.exitCode).toBe(0);
		const bangBreaking = subjects.stdout.toString().split('\n').filter((line) => /^[a-zA-Z]+(\([^)]*\))?!:/.test(line));
		expect(bangBreaking, `breaking-by-syntax subjects after the bound: ${bangBreaking.join('; ')}`).toEqual([]);
		// Per-package coverage: each package needs >=1 commit after the bound,
		// or the lockstep release strands it on its published version.
		for (const pkgPath of Object.keys(EXPECTED_COMPONENT_BY_PATH)) {
			const commits = Bun.spawnSync(['git', '-C', REPO_ROOT, 'log', '--oneline', `${REQUIRED_BOOTSTRAP_SHA}..HEAD`, '--', pkgPath], {
				stdout: 'pipe',
				stderr: 'ignore',
			});
			expect(commits.exitCode).toBe(0);
			expect(commits.stdout.toString().trim().length, `${pkgPath} must have at least one commit after the bound (stranded package)`).toBeGreaterThan(0);
		}
	});
});
