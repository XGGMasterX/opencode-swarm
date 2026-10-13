import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Repo root relative to this test file: packages/opencode/tests/publishing/
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'release-please-config.json');

// The reviewed bootstrap bound: the last BREAKING CHANGE commit on `next`
// (98b020168 "feat!: extract core into monorepo..."). release-please@16's
// bootstrap walk stops EXCLUSIVELY at this sha (manifest.js breaks before
// collecting it), so every breaking commit is excluded from the sweep while
// the packages/telemetry fix commits (376b12730, 6fdebce18) stay in range.
// A bound at the March tip 23f051f1 strands telemetry (no packages/telemetry
// commits in (23f051f1, HEAD]); an earlier bound re-includes the breaking
// commits and re-proposes 9.0.0-beta.0 (issue #3173's misfire).
const REQUIRED_BOOTSTRAP_SHA = '98b020168298679467bce6d5d20ce1fbdf62c06b';
const EXPECTED_COMPONENTS = ['claude-code', 'core', 'opencode', 'telemetry'];

function loadConfig(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) {
		throw new Error(`release-please-config.json not found at ${CONFIG_PATH}`);
	}
	return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

describe('release-please config (issue #3150 release enablement)', () => {
	test('root bootstrap-sha is pinned to the reviewed bound', () => {
		const cfg = loadConfig();
		expect(cfg['bootstrap-sha']).toBe(REQUIRED_BOOTSTRAP_SHA);
		expect(REQUIRED_BOOTSTRAP_SHA).toMatch(/^[0-9a-f]{40}$/);
	});

	test('no dead root-level branches key', () => {
		// release-please@16 and the pinned action read only root-level keys;
		// a `branches` array is silently ignored and misleads readers.
		const cfg = loadConfig();
		expect('branches' in cfg).toBe(false);
	});

	test('per-component tags: include-component-in-tag is true and every package declares its component', () => {
		const cfg = loadConfig();
		// With include-component-in-tag false, strategies/base.js blanks the
		// component: linked-versions can never match and every package shares
		// the collision-prone bare `v<version>` tag namespace (a drifted
		// monorepo then collides tags across version lines).
		expect(cfg['include-component-in-tag']).toBe(true);
		const packages = (cfg['packages'] ?? {}) as Record<string, Record<string, unknown>>;
		const components: string[] = [];
		for (const [pkgPath, entry] of Object.entries(packages)) {
			const component = entry['component'];
			expect(component, `${pkgPath} must declare a component`).toBeTypeOf('string');
			expect((component as string).length, `${pkgPath} component must be non-empty`).toBeGreaterThan(0);
			components.push(component as string);
		}
		expect([...components].sort()).toEqual(EXPECTED_COMPONENTS);
	});

	test('linked-versions lockstep group covers exactly the per-package components', () => {
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
		expect([...((group['components'] ?? []) as string[])].sort()).toEqual(EXPECTED_COMPONENTS);
	});

	// History-dependent leg: CI's actions/checkout is shallow (depth 1) by
	// default and cannot resolve 98b020168; run it only when the anchor is
	// present in this clone (full clones / developer machines) and log an
	// explicit skip otherwise — never fail vacuously.
	test('bootstrap-sha lies on the branch history (explicitly skipped on shallow checkouts)', () => {
		const resolvable = Bun.spawnSync(['git', '-C', REPO_ROOT, 'cat-file', '-e', `${REQUIRED_BOOTSTRAP_SHA}^{commit}`], {
			stdout: 'ignore',
			stderr: 'ignore',
		});
		if (resolvable.exitCode !== 0) {
			console.log(`skip: ${REQUIRED_BOOTSTRAP_SHA} not resolvable in this (shallow?) clone - ancestry unverified here`);
			return;
		}
		const ancestor = Bun.spawnSync(['git', '-C', REPO_ROOT, 'merge-base', '--is-ancestor', REQUIRED_BOOTSTRAP_SHA, 'HEAD'], {
			stdout: 'ignore',
			stderr: 'ignore',
		});
		expect(ancestor.exitCode, 'bootstrap-sha must be an ancestor of HEAD').toBe(0);
	});
});
