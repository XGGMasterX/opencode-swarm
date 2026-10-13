import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Repo root relative to this test file: packages/opencode/tests/publishing/
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release-please-next.yml');

function indentOf(line: string): number {
	const m = /^\s*/.exec(line);
	return m ? m[0].length : 0;
}

// Collect each "- name: Publish ..." step block (the name line through the
// last more-indented line: its run:/env: lines).
function collectPublishSteps(): Array<{ name: string; text: string }> {
	const lines = readFileSync(WORKFLOW_PATH, 'utf8').split(/\r?\n/);
	const steps: Array<{ name: string; text: string }> = [];
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
		steps.push({ name: m[2].trim(), text: block.join('\n') });
		i = j;
	}
	return steps;
}

describe('release-please-next publish steps (issue #3150 silent-skip guard)', () => {
	test('workflow has exactly four Publish steps', () => {
		expect(collectPublishSteps().length).toBe(4);
	});

	test('every publish step propagates failures: pipefail enabled AND an explicit exit 1', () => {
		const steps = collectPublishSteps();
		expect(steps.length).toBe(4);
		for (const { name, text } of steps) {
			// pipefail must be enabled explicitly (either spelling); a bare
			// `exit 1` alone could sit on a branch that never runs.
			expect(/set +-eo pipefail|set +-o pipefail/.test(text), `${name}: pipefail must be enabled`).toBe(true);
			expect(/\bexit 1\b/.test(text), `${name}: must contain an explicit exit 1`).toBe(true);
		}
	});

	test('E403/already-exists tolerance is gated on the force_publish input', () => {
		const steps = collectPublishSteps();
		for (const { name, text } of steps) {
			expect(text.includes('inputs.force_publish'), `${name}: tolerance must reference inputs.force_publish`).toBe(true);
			expect(text.includes('|| cat /tmp/pub.log'), `${name}: ungated || cat masking must not remain`).toBe(false);
		}
	});

	test('the historical ungated skip form is absent from the whole workflow', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(
			raw.includes(`grep -q 'E403\\|already exists' /tmp/pub.log && echo "Already published, skipping" || cat`),
		).toBe(false);
	});
});
