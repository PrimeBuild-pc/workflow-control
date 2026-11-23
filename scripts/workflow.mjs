import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createClient, mergeVerified, owner, verifyPullRequest } from './verification.mjs';

const env = process.env;
assert.equal(env.GITHUB_REPOSITORY, `${owner}/workflow-control`);
assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
assert.equal(env.GITHUB_REF, 'refs/heads/main');
assert.equal(env.GITHUB_ACTOR_ID, '162145141');
assert.equal(env.GITHUB_TRIGGERING_ACTOR, owner);
assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
assert.ok(['verify', 'merge'].includes(env.MODE));

const control = createClient(env.GITHUB_TOKEN);
const run = await control(`repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`);
const age = Date.now() - Date.parse(run.created_at);
assert.ok(age >= 0 && age <= 30 * 60 * 1000, 'Approval expired. Review the PR again.');
const setup = JSON.parse(await readFile(new URL('../targets.json', import.meta.url), 'utf8'));
const request = createClient(env.TARGET_TOKEN);
const verified = await verifyPullRequest(request, {
  repository: env.TARGET_REPOSITORY, number: env.PULL_REQUEST,
  head: env.EXPECTED_HEAD, base: env.EXPECTED_BASE, maintenance: env.MAINTENANCE === 'true',
  releaseVersion: env.RELEASE_VERSION,
}, setup.maintenance);
const result = env.MODE === 'merge'
  ? await mergeVerified(request, verified, { rulesetId: setup.rulesets[verified.repository], appId: Number(env.MERGE_APP_ID) })
  : '';
if (result && verified.release) {
  const receipt = {
    repository: `${owner}/${verified.repository}`,
    pullRequest: Number(verified.number),
    authorizer: env.GITHUB_ACTOR,
    controllerRun: env.GITHUB_RUN_ID,
    head: verified.head,
    base: verified.base,
    testedMerge: verified.merge,
    testedTree: verified.tree,
    ciRun: verified.run,
    commit: result,
    ...verified.release,
  };
  await writeFile(env.RELEASE_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
}
await appendFile(env.GITHUB_STEP_SUMMARY, [
  '### Verified pull request', '',
  `- Repository: ${owner}/${verified.repository}`,
  `- PR: #${verified.number}`,
  `- Approved by: ${env.GITHUB_ACTOR}`,
  `- Head: ${verified.head}`,
  `- Base: ${verified.base}`,
  `- Tested merge: ${verified.merge}`,
  `- CI run: ${verified.run}`,
  result ? `- Merged commit: ${result}` : '- Mode: verification only',
  ...(verified.release ? [
    `- Release version: ${verified.release.version} (${verified.release.type})`,
    `- Approved channels: ${verified.release.channels.join(', ')}`,
  ] : []),
  '',
].join('\n'));
