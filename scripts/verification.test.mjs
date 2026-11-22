import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeVerified, verifyPullRequest } from './verification.mjs';

const repository = 'TweakHub';
const prefix = 'repos/PrimeBuild-pc/TweakHub';
const fullName = 'PrimeBuild-pc/TweakHub';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const result = 'e'.repeat(40);
const input = { repository, number: '44', head, base, maintenance: false };
const metadata = { state: 'open', draft: false, head: { sha: head, repo: { full_name: fullName } },
  base: { sha: base, ref: 'main', repo: { full_name: fullName } }, mergeable: true,
  merge_commit_sha: merge, user: { id: 162145141 }, changed_files: 1 };

function example() {
  const pr = structuredClone(metadata);
  const files = [{ filename: 'README.md' }];
  const jobs = [{ name: 'build-and-test', conclusion: 'success' }];
  const artifact = { name: `verified-merge-${merge}-1`, expired: false };
  const discussions = { pageInfo: { hasNextPage: false }, nodes: [] };
  const rule = { type: 'update', ruleset_id: 7 };
  const checks = { type: 'required_status_checks', ruleset_id: 8,
    parameters: { strict_required_status_checks_policy: true,
      required_status_checks: [{ context: 'build-and-test', integration_id: 15368 }] } };
  const lock = { enforcement: 'active', target: 'branch', rules: [{ type: 'update' }],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: 9, actor_type: 'Integration', bypass_mode: 'pull_request' }] };
  const merged = { tree: { sha: tree }, parents: [{ sha: base }] };
  let merges = 0;
  const request = async (url, options) => {
    if (url === 'graphql') return { data: { repository: { pullRequest: {
      reviewDecision: 'REVIEW_REQUIRED', reviewThreads: discussions,
    } } } };
    assert.ok(url.startsWith(prefix + '/'));
    const route = url.slice(prefix.length + 1);
    switch (route) {
      case 'pulls/44': return pr;
      case 'branches/main': return { commit: { sha: base } };
      case `git/commits/${merge}`: return { sha: merge, parents: [{ sha: base }, { sha: head }], tree: { sha: tree } };
      case 'pulls/44/files?per_page=100&page=1': return files;
      case `actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=1`:
        return { workflow_runs: [{ id: 13, path: '.github/workflows/ci.yml', run_attempt: 1,
          conclusion: 'success', pull_requests: [{ number: 44, head: { sha: head }, base: { sha: base } }] }] };
      case 'actions/runs/13/attempts/1/jobs?per_page=100': return { total_count: jobs.length, jobs };
      case `actions/runs/13/artifacts?name=${artifact.name}`: return { artifacts: [artifact] };
      case 'rules/branches/main': return [rule, checks, { type: 'pull_request', ruleset_id: 8 }];
      case 'rulesets/7': return lock;
      case 'pulls/44/merge':
        assert.deepEqual(options, { method: 'PUT', body: { sha: head, merge_method: 'squash' } });
        merges++;
        return { merged: true, sha: result };
      case `git/commits/${result}`: return merged;
      default: assert.fail(`Unexpected request: ${route}`);
    }
  };
  return { request, pr, files, jobs, artifact, discussions, checks, lock, merged, mergeCount: () => merges };
}

test('checks the tested merge and the tree after a squash', async () => {
  const f = example();
  const verified = await verifyPullRequest(f.request, input);
  assert.equal(verified.tree, tree);
  assert.equal(await mergeVerified(f.request, verified, { rulesetId: 7, appId: 9 }), result);
  assert.equal(f.mergeCount(), 1);
});

test('rejects changed head, unresolved reviews, and a missing CI receipt', async () => {
  const changed = example();
  changed.pr.head.sha = result;
  await assert.rejects(verifyPullRequest(changed.request, input), /head changed/);
  const review = example();
  review.discussions.nodes.push({ isResolved: false });
  await assert.rejects(verifyPullRequest(review.request, input), /discussion/);
  const noReceipt = example();
  noReceipt.artifact.expired = true;
  await assert.rejects(verifyPullRequest(noReceipt.request, input), /exact test merge/);
  const failure = example();
  failure.jobs[0].conclusion = 'failure';
  await assert.rejects(verifyPullRequest(failure.request, input), /did not pass/);
});

test('allows workflow changes only for the exactly pinned owner maintenance PR', async () => {
  const f = example();
  f.files[0] = { filename: 'renamed', previous_filename: '.github/workflows/ci.yml' };
  await assert.rejects(verifyPullRequest(f.request, input), /pinned maintenance approval/);
  const maintenance = { ...input, maintenance: true };
  const approved = { TweakHub: { number: 44, head, base } };
  await assert.rejects(verifyPullRequest(f.request, maintenance), /recorded approval/);
  await verifyPullRequest(f.request, maintenance, approved);
  f.pr.head.repo.full_name = 'Contributor/TweakHub';
  await assert.rejects(verifyPullRequest(f.request, maintenance, approved), /same repository/);
});

test('keeps independent CI rules and refuses a different merged tree', async () => {
  const f = example();
  const verified = await verifyPullRequest(f.request, input);
  f.checks.parameters.strict_required_status_checks_policy = false;
  await assert.rejects(mergeVerified(f.request, verified, { rulesetId: 7, appId: 9 }), /Strict GitHub Actions/);
  assert.equal(f.mergeCount(), 0);
  f.checks.parameters.strict_required_status_checks_policy = true;
  f.merged.tree.sha = result;
  await assert.rejects(mergeVerified(f.request, verified, { rulesetId: 7, appId: 9 }), /contents differ/);
});
