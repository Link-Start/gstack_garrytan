import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createReadinessFixture } from './helpers/sync-gbrain-readiness-fixture';
import { readinessVerdictProblems } from './helpers/sync-gbrain-readiness-verdict';

for (const kind of ['ready', 'unknown'] as const) {
  test(`${kind} actor fixture exercises registered helper without source mutation`, () => {
    const fixture = createReadinessFixture(kind);
    try {
      const check = spawnSync('bun', [`${import.meta.dir}/../bin/gstack-gbrain-read-capability.ts`], {
        cwd: fixture.workDir, env: { ...process.env, ...fixture.env }, encoding: 'utf8', timeout: 10_000,
      });
      expect(check.status).toBe(0);
      expect(JSON.parse(check.stdout).status).toBe(kind);
      expect(fixture.calls()).toEqual([
        'sources list --json', 'list --source client-fixture --limit 1',
        'get code/fixture/readme --source client-fixture --json',
      ]);
      expect(fixture.sourceIntact()).toBe(true);
    } finally { fixture.cleanup(); }
  });
}

test('unknown actor negative replay rejects a contradictory GREEN verdict', () => {
  expect(readinessVerdictProblems('unknown', 'Readiness unknown; guidance preserved. gbrain status: GREEN')).not.toEqual([]);
  expect(readinessVerdictProblems('unknown', 'Capability WARN: read unverified; gbrain status: GREEN')).toContain('unknown result claims GREEN or capability OK');
  expect(readinessVerdictProblems('unknown', 'Capability WARN: read unverified; gbrain status: YELLOW')).toEqual([]);
});

test('ready actor negative replay rejects search/write claims from a read probe', () => {
  expect(readinessVerdictProblems('ready', 'Source read verified; semantic search and write readiness verified.')).not.toEqual([]);
  expect(readinessVerdictProblems('ready', 'Source-scoped page read verified; semantic search and writes were not tested.')).toEqual([]);
});
