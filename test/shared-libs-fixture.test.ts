/** Free checks for the safety and source-fidelity assertions used by paid captures. */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  createSharedInteractiveToolHandler, createSharedLibsFixture, fixtureGit, fixtureWrite, installSourceShims,
  readRequests, seedOpportunitySources, sharedReadOnlyViolations, shellQuote, snapshotFixture, type SharedLibsFixture,
} from './helpers/shared-libs-eval-fixture';
import { E2E_TOUCHFILES, GLOBAL_TOUCHFILES, selectTests } from './helpers/touchfiles';

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-libs-snapshot-'));
  cleanup.push(directory);
  return directory;
}

describe('shared-code legacy interactive actor', () => {
  for (const [choose, labels] of [['approve', ['Fix it', 'Apply remedy', 'Approve', 'Extract helper', 'Reuse library', 'Choice (recommended)']],
    ['skip', ['Skip', 'Keep current', 'Decline', 'Do not change', 'Leave as-is']]] as const) {
    test.each(labels)(`${choose} retains existing first-match answers: %s`, async label => {
      const questions: unknown[] = [], answers: unknown[] = [];
      const callback = createSharedInteractiveToolHandler(choose, {
        nonQuestion: (_name, input) => ({ behavior: 'allow', updatedInput: input }),
        onQuestion: input => { questions.push(input); },
        onAnswer: (input, answer) => { answers.push({ input, answer }); },
      });
      const input = { questions: [1, 2].map(id => ({ question: `Choice ${id}`, header: 'Choice',
        options: [{ label: 'Investigate', description: 'First' }, { label, description: 'Second' },
          { label: `${label} later`, description: 'Third' }] })) };
      expect(await callback('AskUserQuestion', input)).toEqual({ behavior: 'allow', updatedInput: { ...input,
        answers: { 'Choice 1': label, 'Choice 2': label } } });
      expect(questions).toEqual([input]);
      expect(answers).toHaveLength(1);
    });
  }

  test('non-question permissions pass through, and absent legacy choices still throw', async () => {
    const calls: unknown[] = [];
    const callback = createSharedInteractiveToolHandler('approve', {
      nonQuestion: (name, input) => { calls.push({ name, input }); return { behavior: 'allow', updatedInput: input }; },
      onQuestion: () => {}, onAnswer: () => { throw new Error('unexpected answer'); },
    });
    const read = { file_path: '/fixture/PLAN.md' };
    expect(await callback('Read', read)).toEqual({ behavior: 'allow', updatedInput: read });
    expect(calls).toEqual([{ name: 'Read', input: read }]);
    await expect(callback('AskUserQuestion', { questions: [{ question: 'Unknown', options: [{ label: 'Investigate' }] }] }))
      .rejects.toThrow('No approve option in real review question');
  });
});

describe('shared-code fixture snapshots', () => {
  test('empty-directory creation/deletion and root or descendant mode changes are visible', () => {
    const directory = scratch();
    const empty = path.join(directory, 'empty');
    const before = snapshotFixture(directory);
    expect(before['.']).toBe(`dir:${fs.lstatSync(directory).mode}`);
    fs.mkdirSync(empty);
    const created = snapshotFixture(directory);
    expect(created).not.toEqual(before);
    expect(created.empty).toBe(`dir:${fs.lstatSync(empty).mode}`);
    fs.chmodSync(empty, (fs.lstatSync(empty).mode & 0o777) ^ 0o020);
    expect(snapshotFixture(directory)).not.toEqual(created);
    fs.rmSync(empty, { recursive: true });
    expect(snapshotFixture(directory)).toEqual(before);
    fs.chmodSync(directory, (fs.lstatSync(directory).mode & 0o777) ^ 0o020);
    expect(snapshotFixture(directory)).not.toEqual(before);
  });

  test('records a symlink without following its target', () => {
    const directory = scratch();
    const target = scratch();
    fs.writeFileSync(path.join(target, 'outside.txt'), 'original');
    const link = path.join(directory, 'alias');
    fs.symlinkSync(target, link);
    const before = snapshotFixture(directory);
    expect(Object.keys(before).sort()).toEqual(['.', 'alias']);
    fs.writeFileSync(path.join(target, 'outside.txt'), 'changed');
    expect(snapshotFixture(directory)).toEqual(before);
    expect(snapshotFixture(link)).toEqual({ '.': `link:${fs.lstatSync(link).mode}:${target}` });
  });

  (process.platform === 'win32' ? test.skip : test)('records a FIFO without opening it', () => {
    const directory = scratch();
    const fifo = path.join(directory, 'pipe');
    execFileSync('mkfifo', [fifo], { timeout: 10_000 });
    expect(snapshotFixture(directory).pipe).toBe(`special:${fs.lstatSync(fifo).mode}:${fs.lstatSync(fifo).rdev}`);
  });
});

function gh(f: SharedLibsFixture, endpoint: string) {
  return spawnSync(path.join(f.bin, 'gh'), ['api', '-X', 'GET', endpoint], {
    cwd: f.repo, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 10_000,
  });
}

function curl(f: SharedLibsFixture, args: string[]) {
  return spawnSync(path.join(f.bin, 'curl'), args, {
    cwd: f.repo, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 10_000,
  });
}

describe('shared-code curl source isolation', () => {
  test('captured curl output-file attempts are logged and rejected without writing files', () => {
    const f = createSharedLibsFixture('curl-output');
    cleanup.push(f.root);
    installSourceShims(f);
    expect(fs.existsSync(path.join(f.bin, 'curl'))).toBe(true);
    const outside = scratch();
    for (const [name, endpoint] of [['gh_repo.json', ''], ['gh_pulls.json', '/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1']]) {
      const output = path.join(outside, name);
      const response = curl(f, ['-sS', '-m', '20', '-o', output, '-w', 'http=%{http_code}\\n',
        '-H', 'Accept: application/vnd.github+json', `https://api.github.com/repos/fixture/shared-libs${endpoint}`]);
      expect(response.status).not.toBe(0);
      expect(response.stderr).toContain('file output');
      expect(fs.existsSync(output)).toBe(false);
    }
    const hiddenOutput = path.join(outside, 'hidden-exit.json');
    const command = `curl -sS -o ${shellQuote(hiddenOutput)} https://api.github.com/repos/fixture/shared-libs; printf done`;
    const compound = spawnSync('bash', ['-c', command], {
      cwd: f.repo, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 10_000,
    });
    expect(compound.status).toBe(0); // A later successful command cannot erase the rejected write.
    expect(compound.stdout).toBe('done');
    expect(fs.existsSync(hiddenOutput)).toBe(false);
    const requests = readRequests(f).filter(row => row.tool === 'curl');
    expect(requests).toHaveLength(3);
    expect(requests.every(row => row.args.includes('-o'))).toBe(true);
    expect(sharedReadOnlyViolations([], requests).join('\n')).toContain('file output');
  });

  test('stdout GETs preserve successful empty JSON, headers, status and one record per repeated request', () => {
    const f = createSharedLibsFixture('curl-empty');
    cleanup.push(f.root);
    installSourceShims(f);
    const before = snapshotFixture(f.root);
    const endpoint = 'repos/fixture/shared-libs/pulls?state=open&per_page=100&page=1';
    for (let i = 0; i < 2; i++) {
      const response = curl(f, ['-sS', '-m', '20', '-i', '-w', 'http=%{http_code}\\n',
        '-H', 'Accept: application/vnd.github+json', `https://api.github.com/${endpoint}`]);
      expect(response.status, response.stderr).toBe(0);
      expect(response.stdout).toBe('HTTP/2 200\ncontent-type: application/json\n\n[]\nhttp=200\n');
    }
    const repo = curl(f, ['--silent', '--request=GET', '--url=https://api.github.com/repos/fixture/shared-libs']);
    expect(repo.status, repo.stderr).toBe(0);
    expect(JSON.parse(repo.stdout).default_branch).toBe('main');
    const commit = curl(f, ['-sS', 'https://api.github.com/repos/fixture/shared-libs/commits/main']);
    expect(commit.status, commit.stderr).toBe(0);
    expect(JSON.parse(commit.stdout).sha).toBe(f.tip);
    const requests = readRequests(f);
    expect(requests.map(row => row.tool)).toEqual(['curl', 'curl', 'curl', 'curl']);
    expect(requests.slice(0, 2).map(row => row.endpoint)).toEqual([endpoint, endpoint]);
    expect(requests.every(row => row.method === 'GET')).toBe(true);
    expect(sharedReadOnlyViolations([], requests)).toEqual([]);
    const after = snapshotFixture(f.root);
    delete after[path.relative(f.root, f.trace)];
    expect(after).toEqual(before);
  });

  test('curl and gh share immutable source bytes and the old PR second file page', () => {
    const f = createSharedLibsFixture('curl-pinned');
    cleanup.push(f.root);
    seedOpportunitySources(f);
    fixtureGit(f, 'checkout', '-b', 'feature/curl-source');
    fixtureWrite(f, 'src/retry-worker.ts', '  export const exactBranch = true;\n\n');
    fixtureGit(f, 'add', 'src/retry-worker.ts');
    fixtureGit(f, 'commit', '-m', 'distinct branch source');
    const branch = fixtureGit(f, 'rev-parse', 'HEAD');
    installSourceShims(f, { prCoverage: true });
    const oldPr = curl(f, ['-fsSL', 'https://api.github.com/repos/fixture/shared-libs/pulls/42']);
    expect(oldPr.status, oldPr.stderr).toBe(0);
    const pr = JSON.parse(oldPr.stdout);
    expect(pr.updated_at).toBe('2020-01-01T00:00:00Z');
    fixtureWrite(f, 'src/retry-worker.ts', 'different raw overlay');
    for (const revision of [f.tip, branch, pr.head.sha]) {
      const endpoint = `repos/fixture/shared-libs/contents/src/retry-worker.ts?ref=${revision}`;
      const json = curl(f, ['-sS', `https://api.github.com/${endpoint}`]);
      const expected = gh(f, endpoint);
      expect(json.status, json.stderr).toBe(0);
      expect(json.stdout).toBe(expected.stdout);
      const raw = curl(f, ['-sS', '-H', 'Accept: application/vnd.github.raw+json', `https://api.github.com/${endpoint}`]);
      expect(raw.status, raw.stderr).toBe(0);
      expect(raw.stdout).toBe(Buffer.from(JSON.parse(expected.stdout).content, 'base64').toString());
    }
    for (const page of [1, 2, 3]) {
      const endpoint = `repos/fixture/shared-libs/pulls/42/files?per_page=100&page=${page}`;
      const response = curl(f, ['-sS', `https://api.github.com/${endpoint}`]);
      expect(response.status, response.stderr).toBe(0);
      expect(response.stdout).toBe(gh(f, endpoint).stdout);
      const files = JSON.parse(response.stdout);
      expect(files).toHaveLength(page === 1 ? 100 : page === 2 ? 1 : 0);
      if (page === 2) expect(files[0].filename).toBe('src/retry-worker.ts');
    }
    for (const revision of ['main', 'HEAD', 'f'.repeat(40), '__proto__']) {
      const response = curl(f, ['-f', `https://api.github.com/repos/fixture/shared-libs/contents/src/retry-worker.ts?ref=${revision}`]);
      expect(response.status).toBe(22);
      expect(response.stderr).toContain('unsupported or unpinned');
      expect(response.stdout).toBe('');
    }
  });

  test('unavailable API stays a visible 403 and never becomes a successful empty result', () => {
    const f = createSharedLibsFixture('curl-unavailable');
    cleanup.push(f.root);
    installSourceShims(f, { unavailableApi: true });
    const url = 'https://api.github.com/repos/fixture/shared-libs/pulls?state=open&page=1';
    const response = curl(f, ['-sS', '-w', 'http=%{http_code}\\n', url]);
    expect(response.status).toBe(0); // curl without --fail reports HTTP errors in its body/status.
    expect(response.stdout).toContain('API unavailable in this fixture');
    expect(response.stdout).toEndWith('http=403\n');
    expect(response.stdout).not.toContain('[]');
    const failed = curl(f, ['-fsS', '-w', '%{response_code}', url]);
    expect(failed.status).toBe(22);
    expect(failed.stdout).toBe('403');
    expect(failed.stderr).toContain('API unavailable in this fixture');
    expect(sharedReadOnlyViolations([], readRequests(f))).toEqual([]);
  });

  test('the captured null sink discards response bytes and headers without a persistent write', () => {
    const f = createSharedLibsFixture('curl-null-output');
    cleanup.push(f.root);
    installSourceShims(f);
    const before = snapshotFixture(f.root);
    const url = 'https://api.github.com/repos/fixture/shared-libs';
    const response = curl(f, ['-sS', '-m', '15', '-o', '/dev/null', '-w', 'http=%{http_code}\\n', url]);
    expect(response.status, response.stderr).toBe(0);
    expect(response.stdout).toBe('http=200\n');
    const discardHeaders = curl(f, ['-sS', '--dump-header', '/dev/null', url]);
    expect(discardHeaders.status, discardHeaders.stderr).toBe(0);
    expect(discardHeaders.stdout).not.toContain('HTTP/2');
    expect(JSON.parse(discardHeaders.stdout).default_branch).toBe('main');
    const stdoutHeaders = curl(f, ['-sS', '--dump-header', '-', '--output', '/dev/null', url]);
    expect(stdoutHeaders.status, stdoutHeaders.stderr).toBe(0);
    expect(stdoutHeaders.stdout).toBe('HTTP/2 200\ncontent-type: application/json\n\n');
    expect(sharedReadOnlyViolations([], readRequests(f))).toEqual([]);
    const after = snapshotFixture(f.root);
    delete after[path.relative(f.root, f.trace)];
    expect(after).toEqual(before);
  });

  test('unknown URLs, methods and file-producing curl options are rejected by the shim', () => {
    const f = createSharedLibsFixture('curl-rejected');
    cleanup.push(f.root);
    installSourceShims(f);
    const url = 'https://api.github.com/repos/fixture/shared-libs';
    const outside = scratch();
    const output = path.join(outside, 'must-not-exist');
    const cases = [
      ['https://example.invalid/repos/fixture/shared-libs'],
      ['http://127.0.0.1:9/'], ['file:///etc/passwd'],
      ['https://api.github.com/repos/another/repository'],
      ['https://api.github.com/repos/fixture/shared-libs/unknown'],
      ['-X', 'POST', url], ['--request=DELETE', url], ['-I', url],
      ['--output=' + output, url], ['-o' + output, url], ['-O', url],
      ['-D', output, url], ['--cookie-jar', output, url], ['--trace-ascii', output, url],
      ['--libcurl', output, url], ['--stderr', output, url],
      ['-w', '%output{' + output + '}%{http_code}', url],
      ['--write-out', '@' + output, url],
      ['--config', output, url], ['--data', 'value', url],
    ];
    for (const args of cases) {
      const response = curl(f, args);
      expect(response.status, JSON.stringify(args)).toBe(2);
      expect(response.stderr).toContain('Fixture curl rejected:');
      expect(response.stdout).toBe('');
      expect(fs.existsSync(output)).toBe(false);
    }
    const requests = readRequests(f);
    expect(requests).toHaveLength(cases.length);
    expect(requests.every(row => row.tool === 'curl' && !!row.violation)).toBe(true);
    expect(sharedReadOnlyViolations([], requests).length).toBeGreaterThan(0);
  });

  test('shared safety checks catch attempted writes even when a shell continues or no provider ran', () => {
    const bash = (command: string) => [{ tool: 'Bash', input: { command } }];
    for (const command of [
      "curl -sS -m 20 -o /tmp/gh_repo.json -w 'http=%{http_code}\\n' -H 'Accept: application/vnd.github+json' https://api.github.com/repos/fixture/shared-libs; echo done",
      '/usr/bin/curl --output=/tmp/report.json https://api.github.com/repos/fixture/shared-libs || true',
      "curl -w '%output{/tmp/report}%{http_code}' https://api.github.com/repos/fixture/shared-libs",
      "curl -X POST https://api.github.com/repos/fixture/shared-libs",
      'printf data > /tmp/report', 'cat README.md >> "/tmp/report"', 'cat README.md | tee /tmp/report',
      "bash <<'SH'\nprintf data > /tmp/report\nSH\n",
      "cat <<'DATA'\njust data\nDATA\ncurl -o /tmp/report https://api.github.com/repos/fixture/shared-libs",
    ]) expect(sharedReadOnlyViolations(bash(command)).length, command).toBeGreaterThan(0);
    expect(sharedReadOnlyViolations([{ tool: 'Write', input: { file_path: '/tmp/report', content: '' } }])).not.toEqual([]);
    for (const command of [
      "curl -fsSL -H 'Accept: application/vnd.github+json' 'https://api.github.com/repos/fixture/shared-libs/pulls?state=open&per_page=100&page=1' | head -c 600",
      "curl -sS -o - -w 'http=%{http_code}\\n' https://api.github.com/repos/fixture/shared-libs",
      "curl -sS -m 15 -o /dev/null -w 'http=%{http_code}\\n' https://api.github.com/repos/fixture/shared-libs 2>&1",
      'gh auth status 2>&1 | head -5', 'git --no-lazy-fetch log 2>/dev/null',
      "rg 'a > b' README.md", "rg '>' README.md", "rg '|' README.md",
      'rg tee README.md', 'rg curl README.md',
      "python3 - <<'PY'\nsize = 2\nif size > 1:\n    print(size)\nPY\n",
      "cat <<'DATA'\ncurl -o example.json https://example.invalid\nDATA\n",
    ]) expect(sharedReadOnlyViolations(bash(command)), command).toEqual([]);
  });
});

function pinnedSource(f: SharedLibsFixture, revision: string, file: string) {
  const response = gh(f, `repos/fixture/shared-libs/contents/${file}?ref=${revision}`);
  expect(response.status, response.stderr).toBe(0);
  const body = JSON.parse(response.stdout);
  const expectedBlob = fixtureGit(f, 'rev-parse', `${revision}:${file}`);
  const bytes = execFileSync(Bun.which('git') || 'git', ['cat-file', 'blob', expectedBlob], {
    cwd: f.repo, env: { ...process.env, ...f.env }, timeout: 10_000,
  });
  expect(body.sha).toBe(expectedBlob);
  expect(Buffer.from(body.content, 'base64')).toEqual(bytes);
  return bytes;
}

describe('shared-code Contents API revision fidelity', () => {
  test('default, branch and PR SHAs return their own exact committed bytes, excluding raw overlays', () => {
    const f = createSharedLibsFixture('source-fidelity');
    cleanup.push(f.root);
    seedOpportunitySources(f);
    fixtureGit(f, 'checkout', '-b', 'feature/pinned-source');
    fixtureWrite(f, 'src/retry-worker.ts', '  export const branchParser = true;\n\n');
    fixtureGit(f, 'add', 'src/retry-worker.ts');
    fixtureGit(f, 'commit', '-m', 'use a distinct branch implementation');
    const branch = fixtureGit(f, 'rev-parse', 'HEAD');
    installSourceShims(f, { prCoverage: true });
    const prResponse = gh(f, 'repos/fixture/shared-libs/pulls/42');
    expect(prResponse.status, prResponse.stderr).toBe(0);
    const prHead = JSON.parse(prResponse.stdout).head.sha;
    expect(new Set([f.tip, branch, prHead]).size).toBe(3);
    fixtureWrite(f, 'src/retry-worker.ts', 'uncommitted raw overlay');
    const source = [f.tip, branch, prHead].map(revision => pinnedSource(f, revision, 'src/retry-worker.ts'));
    expect(source[1].toString()).toBe('  export const branchParser = true;\n\n');
    expect(source[2].toString()).toBe("export { retrySeconds } from '../lib/retry-after';\n");
    expect(new Set(source.map(bytes => bytes.toString('base64'))).size).toBe(3);
  });

  test('unknown SHAs, moving refs, omitted refs and missing source never succeed as default-tip content', () => {
    const f = createSharedLibsFixture('unknown-revision');
    cleanup.push(f.root);
    installSourceShims(f);
    for (const suffix of ['', '?ref=main', '?ref=HEAD', `?ref=${'f'.repeat(40)}`, '?ref=__proto__']) {
      const response = gh(f, `repos/fixture/shared-libs/contents/README.md${suffix}`);
      expect(response.status).not.toBe(0);
      expect(response.stderr).toContain('unsupported or unpinned fixture revision');
      expect(response.stdout).toBe('');
    }
    for (const file of ['missing.ts', 'toString']) {
      const response = gh(f, `repos/fixture/shared-libs/contents/${file}?ref=${f.tip}`);
      expect(response.status).not.toBe(0);
      expect(response.stdout).toBe('');
    }
  });
});

const interactive = [
  'shared-libs-plan-callers', 'shared-libs-review-index-flags', 'shared-libs-review-lifecycle',
  'shared-libs-review-path-eligibility', 'shared-libs-review-prior-coverage', 'shared-libs-review-revalidation',
];
const judged = ['shared-libs-opportunity-judgment', 'shared-libs-plan-callers', 'shared-libs-pr-coverage'];
const allShared = Object.keys(E2E_TOUCHFILES).filter(name => name.startsWith('shared-libs-')).sort();
const selected = (dependency: string) => selectTests([dependency], E2E_TOUCHFILES, GLOBAL_TOUCHFILES)
  .selected.filter(name => name.startsWith('shared-libs-')).sort();

describe('shared-code paid dependency selection', () => {
  test('SDK and judge changes select the actual affected owners', () => {
    expect(selected('test/helpers/agent-sdk-runner.ts')).toEqual(interactive);
    expect(selected('test/helpers/llm-judge.ts')).toEqual(judged);
  });

  test('generation, gating, fixture validation and host support keep their coverage owners', () => {
    for (const dependency of ['scripts/gen-skill-docs.ts', 'test/helpers/e2e-gate.ts', 'test/shared-libs-fixture.test.ts']) {
      expect(selected(dependency)).toEqual(allShared);
    }
    expect(selected('lib/claude-bin.ts')).toEqual(allShared.filter(name => name !== 'shared-libs-codex-read-only'));
    expect(selected('lib/eval-model.ts')).toEqual(allShared.filter(name => name !== 'shared-libs-codex-read-only'));
    for (const dependency of ['hosts/codex.ts', 'hosts/define-host.ts', 'scripts/resolvers/constants.ts']) {
      expect(selected(dependency)).toContain('shared-libs-codex-read-only');
    }
  });
});
