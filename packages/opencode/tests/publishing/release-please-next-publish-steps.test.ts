import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Repo root relative to this test file: packages/opencode/tests/publishing/
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release-please-next.yml');
const CONFIG_PATH = path.join(REPO_ROOT, 'release-please-config.json');

function indentOf(line: string): number {
	const m = /^\s*/.exec(line);
	return m ? m[0].length : 0;
}

function isCommentLine(line: string): boolean {
	return line.trimStart().startsWith('#');
}

// Collect each "- name: Publish ..." step block (the name line through the
// last more-indented line: its run:/env: lines). Comment lines are STRIPPED
// from the block text before any assertion consumes it: a token hidden in a
// comment (`# set -eo pipefail`) must not satisfy a semantic assertion.
function collectPublishSteps(): Array<{ name: string; text: string; codeLines: string[] }> {
	const lines = readFileSync(WORKFLOW_PATH, 'utf8').split(/\r?\n/);
	const steps: Array<{ name: string; text: string; codeLines: string[] }> = [];
	let i = 0;
	while (i < lines.length) {
		const m = /^(\s*)-\s+name:\s*(Publish\S?.*)$/.exec(lines[i]);
		if (!m) {
			i += 1;
			continue;
		}
		const indent = m[1].length;
		const block: string[] = [lines[i]];
		let j = i + 1;
		while (j < lines.length) {
			const ln = lines[j];
			if (ln.trim() === '') {
				block.push(ln);
				j += 1;
				continue;
			}
			if (indentOf(ln) <= indent) break;
			block.push(ln);
			j += 1;
		}
		const codeLines = block.filter((ln) => ln.trim() !== '' && !isCommentLine(ln));
		steps.push({ name: m[2].trim(), text: codeLines.join('\n') });
		i = j;
	}
	return steps;
}

function collectPackagePaths(): string[] {
	if (!existsSync(CONFIG_PATH)) {
		throw new Error(`release-please-config.json not found at ${CONFIG_PATH}`);
	}
	const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { packages?: Record<string, unknown> };
	return Object.keys(cfg.packages ?? {}).sort();
}

// The ONLY tolerated skip reason: npm's version-conflict rejection (and the
// generic "already exists" phrasing). Deliberately message-specific — npm
// emits code E403 for genuine authorization failures too, and those must
// fail the job.
const TOLERANCE_PATTERN = "grep -q 'cannot publish over the previously published versions\\|already exists' /tmp/pub.log";

describe('release-please-next publish steps (issue #3150 silent-skip guard)', () => {
	test('workflow has exactly four Publish steps', () => {
		expect(collectPublishSteps().length).toBe(4);
	});

	test('every publish step is bound to exactly one configured package (no duplicate, no omission)', () => {
		const steps = collectPublishSteps();
		const packagePaths = collectPackagePaths();
		expect(steps.length).toBe(packagePaths.length);
		for (const pkgPath of packagePaths) {
			const matching = steps.filter(({ text }) => text.includes(`cd ${pkgPath}`));
			expect(matching.length, `${pkgPath} must be published by exactly one step (found ${matching.length})`).toBe(1);
		}
	});

	test('every publish step propagates failures: pipefail enabled AND an explicit exit 1 on a real code line', () => {
		const steps = collectPublishSteps();
		expect(steps.length).toBeGreaterThan(0);
		for (const { name, text } of steps) {
			// pipefail must be enabled explicitly (either spelling) on a
			// non-comment line; a bare `exit 1` alone could sit on a branch
			// that never runs.
			expect(/set +-eo pipefail|set +-o pipefail/.test(text), `${name}: pipefail must be enabled`).toBe(true);
			expect(/\bexit 1\b/.test(text), `${name}: must contain an explicit exit 1`).toBe(true);
		}
	});

	test('the version-conflict tolerance is gated on the force_publish input', () => {
		const steps = collectPublishSteps();
		for (const { name, text } of steps) {
			expect(text.includes(TOLERANCE_PATTERN), `${name}: tolerance must use the message-specific conflict pattern`).toBe(true);
			expect(text.includes('inputs.force_publish'), `${name}: tolerance must reference inputs.force_publish`).toBe(true);
			expect(text.includes('|| cat /tmp/pub.log'), `${name}: ungated || cat masking must not remain`).toBe(false);
		}
	});

	test('no publish step neutralizes its own failure via continue-on-error', () => {
		const steps = collectPublishSteps();
		for (const { name, text } of steps) {
			expect(/continue-on-error\s*:/.test(text), `${name}: continue-on-error must not appear (it would neutralize exit 1)`).toBe(false);
		}
	});

	test('the publish job is gated on a release existing or an explicit force_publish dispatch', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		const jobIf = /publish-npm-next:[\s\S]*?\n\s*if:\s*(.*)/.exec(raw);
		expect(jobIf, 'publish-npm-next must carry a job-level if: gate').not.toBeNull();
		const gate = jobIf?.[1] ?? '';
		expect(gate.includes('releases_created'), 'gate must reference releases_created').toBe(true);
		expect(gate.includes('force_publish'), 'gate must reference force_publish').toBe(true);
	});

	test('the historical ungated skip form is absent from the whole workflow', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(
			raw.includes(`grep -q 'E403\\|already exists' /tmp/pub.log && echo "Already published, skipping" || cat`),
		).toBe(false);
	});
});
