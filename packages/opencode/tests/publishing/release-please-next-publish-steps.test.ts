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

	test('every publish step propagates failures: statement-shaped pipefail, if-guarded pipeline, and a reachable exit 1', () => {
		const steps = collectPublishSteps();
		expect(steps.length).toBeGreaterThan(0);
		for (const { name, text } of steps) {
			// Line-SHAPED assertions, not token presence: each required construct
			// must appear as a real statement line (comments are already
			// stripped), so `true # set -eo pipefail`, an `echo "..."` string
			// embedding the tokens, or an unreachable `if false; then exit 1; fi`
			// arm all fail.
			const codeLines = text.split('\n');
			const pipefailStatement = codeLines.find((ln) => {
				const t = ln.trim();
				return /^set\s+-e/.test(t) && /pipefail/.test(t);
			});
			expect(pipefailStatement, `${name}: a real 'set ... pipefail' statement line is required`).toBeTypeOf('string');
			const pipelineGuard = codeLines.find((ln) => /^\s*if ! npm publish .*\| tee \/tmp\/pub\.log; then$/.test(ln));
			expect(pipelineGuard, `${name}: npm publish must run inside 'if ! npm publish ... | tee /tmp/pub.log; then'`).toBeTypeOf('string');
			const exitLine = codeLines.find((ln) => ln.trim() === 'exit 1');
			expect(exitLine, `${name}: an exact 'exit 1' statement line is required`).toBeTypeOf('string');
		}
	});

	test('the version-conflict tolerance is gated on the force_publish input', () => {
		const steps = collectPublishSteps();
		for (const { name, text } of steps) {
			const codeLines = text.split('\n');
			// The gate must be ONE condition line that binds BOTH the input and
			// the message-specific tolerance pattern — a mention of the input
			// anywhere else (echo, comment, separate branch) does not gate the
			// tolerance.
			const gateLine = codeLines.find(
				(ln) => ln.trim().startsWith('if [') && ln.includes('inputs.force_publish') && ln.includes(TOLERANCE_PATTERN),
			);
			expect(gateLine, `${name}: the tolerance grep must be gated by 'if [ "...inputs.force_publish..." = "true" ] && grep' on a single line`).toBeTypeOf('string');
			expect(gateLine.includes('|| cat /tmp/pub.log'), `${name}: ungated || cat masking must not remain`).toBe(false);
		}
	});

	test('continue-on-error appears nowhere in the workflow (step-level, quoted, or job-level)', () => {
		// A raw-text scan: job-level and quoted ("continue-on-error": true)
		// variants hide outside individual step blocks, and any form would
		// neutralize the fail-closed exit this file guards.
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(raw.includes('continue-on-error'), 'continue-on-error must not appear anywhere in the workflow').toBe(false);
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
