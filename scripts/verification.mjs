import assert from 'node:assert/strict';
import { verifyReleaseIntent } from './release-intent.mjs';

export const owner = 'PrimeBuild-pc';
const sha = /^[a-f0-9]{40}$/u;

export const targets = {
  LightCrosshair: { workflow: 'build-and-test.yml', checks: ['build'] },
  TweakHub: { workflow: 'ci.yml', checks: ['build-and-test'] },
  ThreadPilot: { workflow: 'ci-devsecops.yml', checks: ['build-test-scan'] },
  SockTuner: { workflow: 'ci.yml', checks: ['build-test'] },
  ZapTweaks: { workflow: 'flutter-ci.yml', checks: ['analyze-and-test'] },
  NeuroTune: { workflow: 'check.yml', checks: [
    'test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)',
    'test (windows-latest, 22)', 'test (windows-latest, 24)', 'merge-evidence',
  ] },
  'discord-theme-launcher': { workflow: 'check.yml', checks: ['verify', 'windows', 'merge-evidence'] },
};

export function createClient(token) {
  assert.ok(token, 'Missing GitHub token.');
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`https://api.github.com/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    assert.ok(response.ok, `GitHub API returned HTTP ${response.status} for ${method} ${path}.`);
    return response.json();
  };
}

export async function verifyPullRequest(request, { repository, number, head, base, maintenance, releaseVersion }, approvedMaintenance = {}) {
  assert.ok(Object.hasOwn(targets, repository), 'Repository is not in the rollout.');
  assert.match(number, /^[1-9][0-9]*$/u);
  assert.match(head, sha, 'Enter the full reviewed PR head SHA.');
  assert.match(base, sha, 'Enter the full reviewed main SHA.');
  const target = targets[repository];
  const fullName = `${owner}/${repository}`;
  const prefix = `repos/${fullName}`;
  const get = path => request(`${prefix}/${path}`);
  const pull = `pulls/${number}`;

  async function snapshot() {
    const [pr, branch] = await Promise.all([get(pull), get('branches/main')]);
    assert.equal(pr.state, 'open');
    assert.equal(pr.draft, false);
    assert.equal(pr.base.ref, 'main');
    assert.equal(pr.base.repo.full_name, fullName);
    assert.equal(pr.head.sha, head, 'PR head changed after review.');
    assert.equal(pr.base.sha, base, 'PR base changed after review.');
    assert.equal(branch.commit.sha, base, 'Main changed after review.');
    assert.equal(pr.mergeable, true, 'GitHub did not confirm a clean merge.');
    assert.match(pr.merge_commit_sha, sha);
    return pr;
  }

  const pr = await snapshot();
  const merge = await get(`git/commits/${pr.merge_commit_sha}`);
  assert.deepEqual(merge.parents.map(parent => parent.sha), [base, head], 'Wrong test merge parents.');
  assert.ok(pr.changed_files > 0 && pr.changed_files <= 3000, 'Complete PR file list required.');
  const files = [];
  for (let page = 1; files.length < pr.changed_files; page++) {
    const batch = await get(`${pull}/files?per_page=100&page=${page}`);
    assert.ok(batch.length > 0, 'PR file list is incomplete.');
    files.push(...batch);
  }
  assert.equal(files.length, pr.changed_files, 'PR file list changed.');
  const workflowChanged = files.some(file => [file.filename, file.previous_filename]
    .some(name => name?.toLowerCase().startsWith('.github/')));
  if (workflowChanged || maintenance) {
    assert.equal(maintenance, true, 'Workflow changes require a pinned maintenance approval.');
    assert.equal(pr.head.repo.full_name, fullName, 'Maintenance PRs must come from the same repository.');
    assert.equal(pr.user.id, 162145141, 'Maintenance PRs must be authored by the owner.');
    assert.deepEqual(approvedMaintenance[repository], { number: Number(number), head, base },
      'The maintenance PR does not match the recorded approval.');
  }
  const release = await verifyReleaseIntent(get, repository, files, merge.sha, releaseVersion);

  const review = await request('graphql', {
    method: 'POST',
    body: {
      query: 'query($owner:String!,$repository:String!,$number:Int!){repository(owner:$owner,name:$repository){pullRequest(number:$number){reviewDecision reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}',
      variables: { owner, repository, number: Number(number) },
    },
  });
  assert.ok(!review.errors, 'GitHub review checks were unavailable.');
  const { reviewDecision, reviewThreads } = review.data.repository.pullRequest;
  assert.notEqual(reviewDecision, 'CHANGES_REQUESTED', 'A reviewer requested changes.');
  assert.ok(!reviewThreads.pageInfo.hasNextPage && reviewThreads.nodes.every(thread => thread.isResolved),
    'A review discussion still needs resolution.');

  const { workflow_runs: [run] } = await get(
    `actions/workflows/${target.workflow}/runs?event=pull_request&head_sha=${head}&per_page=1`,
  );
  assert.equal(run?.conclusion, 'success', 'The latest PR CI run must have succeeded.');
  assert.equal(run.path, `.github/workflows/${target.workflow}`);
  if (run.pull_requests?.length) {
    assert.ok(run.pull_requests.some(item => item.number === Number(number)
      && item.head.sha === head && item.base.sha === base), 'CI recorded different reviewed revisions.');
  }
  const { jobs, total_count: totalJobs } = await get(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  assert.equal(jobs.length, totalJobs, 'The workflow job list is incomplete.');
  for (const name of target.checks) {
    const matching = jobs.filter(job => job.name === name);
    assert.equal(matching.length, 1, `Expected exactly one Actions job named ${name}.`);
    assert.equal(matching[0].conclusion, 'success', `Required CI job ${name} did not pass.`);
  }
  const name = `verified-merge-${merge.sha}-${run.run_attempt}`;
  const { artifacts } = await get(`actions/runs/${run.id}/artifacts?name=${name}`);
  assert.equal(artifacts.filter(artifact => artifact.name === name && !artifact.expired).length, 1,
    'CI did not record the exact test merge for this attempt.');
  const latest = await snapshot();
  assert.equal(latest.merge_commit_sha, merge.sha, 'Test merge changed during verification.');
  return { prefix, pull, repository, number, head, base, merge: merge.sha, tree: merge.tree.sha, run: run.id, release };
}

export async function mergeVerified(request, verified, { rulesetId, appId }) {
  assert.ok(Number.isSafeInteger(rulesetId) && rulesetId > 0, 'Exclusive merge rule is not configured.');
  const { prefix, pull, base, head, tree, merge, repository } = verified;
  const [rules, lock] = await Promise.all([
    request(`${prefix}/rules/branches/main`),
    request(`${prefix}/rulesets/${rulesetId}`),
  ]);
  assert.equal(lock.enforcement, 'active');
  assert.equal(lock.target, 'branch');
  assert.deepEqual(lock.rules.map(rule => rule.type), ['update']);
  assert.deepEqual(lock.conditions.ref_name, { include: ['~DEFAULT_BRANCH'], exclude: [] });
  if (lock.bypass_actors) {
    assert.deepEqual(lock.bypass_actors, [{ actor_id: appId, actor_type: 'Integration', bypass_mode: 'pull_request' }]);
  }
  assert.ok(rules.some(rule => rule.type === 'update' && rule.ruleset_id === rulesetId), 'Exclusive merge rule is inactive on main.');
  assert.ok(rules.some(rule => rule.type === 'pull_request' && rule.ruleset_id !== rulesetId));
  for (const name of targets[repository].checks.filter(check => check !== 'merge-evidence')) {
    assert.ok(rules.some(rule => rule.type === 'required_status_checks' && rule.ruleset_id !== rulesetId
      && rule.parameters.strict_required_status_checks_policy
      && rule.parameters.required_status_checks.some(check => check.context === name && check.integration_id === 15368)),
    `Strict GitHub Actions protection is missing for ${name}.`);
  }
  const [pr, branch] = await Promise.all([request(`${prefix}/${pull}`), request(`${prefix}/branches/main`)]);
  assert.equal(pr.state, 'open');
  assert.equal(pr.draft, false);
  assert.equal(pr.base.ref, 'main');
  assert.equal(pr.base.sha, base);
  assert.equal(branch.commit.sha, base);
  assert.equal(pr.head.sha, head);
  assert.equal(pr.merge_commit_sha, merge);
  const result = await request(`${prefix}/${pull}/merge`, {
    method: 'PUT',
    body: { sha: head, merge_method: 'squash' },
  });
  assert.equal(result.merged, true);
  const commit = await request(`${prefix}/git/commits/${result.sha}`);
  assert.deepEqual(commit.parents.map(parent => parent.sha), [base], 'Merged commit was based on a different main.');
  assert.equal(commit.tree.sha, tree, 'Merged contents differ from the tested contents.');
  return result.sha;
}
