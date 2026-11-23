import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateReleaseIntent } from './release-intent.mjs';
import { owner, targets } from './verification.mjs';

const controller = `${owner}/workflow-control`;
const sha = /^[a-f0-9]{40}$/u;

function gitHub(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
}

const [repository, runId, ...extra] = process.argv.slice(2);
assert.ok(repository && Object.hasOwn(targets, repository) && /^[1-9][0-9]*$/u.test(runId ?? '') && !extra.length,
  'Usage: node scripts/inspect-release.mjs <repository name> <controller run ID>');
const run = gitHub(`repos/${controller}/actions/runs/${runId}`);
assert.equal(run.path, '.github/workflows/merge.yml');
assert.equal(run.event, 'workflow_dispatch');
assert.equal(run.head_branch, 'main');
assert.equal(run.actor.id, 162145141);
assert.equal(run.run_attempt, 1);
assert.equal(run.conclusion, 'success');

const directory = mkdtempSync(join(tmpdir(), 'verified-release-'));
const receiptPath = join(directory, 'release-approval.json');
let approval;
try {
  execFileSync('gh', ['run', 'download', runId, '--repo', controller,
    '--name', 'release-approval', '--dir', directory], { stdio: 'pipe' });
  approval = JSON.parse(readFileSync(receiptPath, 'utf8'));
} finally {
  try {
    unlinkSync(receiptPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  rmdirSync(directory);
}

const fullName = `${owner}/${repository}`;
const prefix = `repos/${fullName}`;
assert.equal(approval.repository, fullName);
assert.equal(approval.controllerRun, runId);
assert.equal(approval.authorizer, owner);
assert.ok(Number.isSafeInteger(approval.pullRequest) && approval.pullRequest > 0);
for (const field of ['commit', 'head', 'base', 'testedTree']) assert.match(approval[field], sha);
const { version, type, channels } = approval;
validateReleaseIntent(repository, version, { version, type, channels });

const pull = gitHub(`${prefix}/pulls/${approval.pullRequest}`);
assert.equal(pull.merged, true);
assert.equal(pull.merged_by.login, 'primebuild-workflow-merge[bot]');
assert.equal(pull.head.sha, approval.head);
assert.equal(pull.merge_commit_sha, approval.commit);
assert.equal(pull.base.ref, 'main');
const merged = gitHub(`${prefix}/git/commits/${approval.commit}`);
assert.equal(merged.tree.sha, approval.testedTree);
assert.deepEqual(merged.parents.map(parent => parent.sha), [approval.base]);
const relation = gitHub(`${prefix}/compare/${approval.commit}...main`);
assert.ok(['identical', 'ahead'].includes(relation.status), 'The approved commit is no longer on main.');

const tag = `v${version}`;
const tagRef = `refs/tags/${tag}`;
const refs = execFileSync('git', ['ls-remote', `https://github.com/${fullName}.git`, tagRef, `${tagRef}^{}`],
  { encoding: 'utf8' });
const resolved = new Map(refs.trim().split('\n').filter(Boolean).map(line => {
  const [commit, ref] = line.trim().split('\t');
  return [ref, commit];
}));
const existing = resolved.get(`${tagRef}^{}`) ?? resolved.get(tagRef);
if (existing) assert.equal(existing, approval.commit, 'The tag points to a different release commit.');

console.log(JSON.stringify({ repository: fullName, tag, commit: approval.commit, type, channels,
  tagStatus: existing ? 'matches approved commit' : 'not created', controllerRun: runId }, null, 2));
