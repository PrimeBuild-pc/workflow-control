import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleaseIntent, verifyReleaseIntent } from './release-intent.mjs';
import { targets } from './verification.mjs';

const beta = { version: '1.2.3-beta.1', type: 'prerelease', channels: ['github'] };
const stable = { version: '1.2.3', type: 'stable', channels: ['github'] };
const merge = 'a'.repeat(40);
const changed = [{ filename: 'release-intent.json', status: 'modified' }];

test('each registered repository can approve its supported release', () => {
  for (const repository of Object.keys(targets)) {
    assert.equal(validateReleaseIntent(repository, beta.version, beta), beta);
  }
  assert.equal(validateReleaseIntent('LightCrosshair', stable.version,
    { ...stable, channels: ['github', 'winget', 'chocolatey'] }).type, 'stable');
  assert.throws(() => validateReleaseIntent('NeuroTune', stable.version, stable), /beta packaging only/);
  assert.throws(() => validateReleaseIntent('TweakHub', stable.version,
    { ...stable, channels: ['github', 'chocolatey'] }), /unsupported/);
  assert.throws(() => validateReleaseIntent('ThreadPilot', beta.version,
    { ...beta, channels: ['github', 'winget'] }), /unsupported/);
});

test('requires exact version, release type and unique channels', () => {
  assert.throws(() => validateReleaseIntent('SockTuner', stable.version, beta), /approved version differs/);
  assert.throws(() => validateReleaseIntent('SockTuner', beta.version, { ...beta, type: 'stable' }), /type does not match/);
  assert.throws(() => validateReleaseIntent('SockTuner', stable.version, { ...stable, channels: ['github', 'github'] }), /unique/);
  assert.throws(() => validateReleaseIntent('SockTuner', '1.2.3-beta.01', beta), /leading zero/);
  assert.throws(() => validateReleaseIntent('SockTuner', '1.2.3\n', stable), /release version/);
});

test('ordinary merges leave old or removed release intents inactive', async () => {
  const noRequest = () => assert.fail('An ordinary merge must not read an old release intent.');
  assert.equal(await verifyReleaseIntent(noRequest, 'ZapTweaks', [], merge), null);
  assert.equal(await verifyReleaseIntent(noRequest, 'ZapTweaks', [{ ...changed[0], status: 'removed' }], merge), null);
  await assert.rejects(verifyReleaseIntent(noRequest, 'ZapTweaks', [], merge, stable.version), /add or update/);
});

test('checks the changed intent in the CI-tested tree before the merge', async () => {
  const sources = new Map([
    ['LightCrosshair', ['LightCrosshair/LightCrosshair.csproj', '<Version>1.2.3</Version>', stable]],
    ['TweakHub', ['TweakHub.csproj', '<VersionPrefix>1.2.3</VersionPrefix><VersionSuffix>beta.1</VersionSuffix>', beta]],
    ['ThreadPilot', ['ThreadPilot.csproj', '<Version>1.2.3</Version>', stable]],
    ['SockTuner', ['Directory.Build.props', '<Version>1.2.3</Version>', stable]],
    ['ZapTweaks', ['pubspec.yaml', 'name: zaptweaks\nversion: 1.2.3+14\n', stable]],
    ['NeuroTune', ['package.json', '{"version":"1.2.3-beta.1"}', beta]],
    ['discord-theme-launcher', ['package.json', '{"version":"1.2.3-beta.1"}', beta]],
  ]);
  function blob(text) {
    const bytes = Buffer.from(text);
    return { type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') };
  }
  for (const [repository, [path, contents, intent]] of sources) {
    const get = async route => {
      if (route === `contents/release-intent.json?ref=${merge}`) return blob(JSON.stringify(intent));
      assert.equal(route, `contents/${path}?ref=${merge}`);
      return blob(contents);
    };
    await assert.rejects(verifyReleaseIntent(get, repository, changed, merge), /Enter the release version/);
    assert.deepEqual(await verifyReleaseIntent(get, repository, changed, merge, intent.version), intent);
  }
  const incorrect = async route => route.includes('release-intent') ? blob(JSON.stringify(stable)) : blob('version: 2.0.0');
  await assert.rejects(verifyReleaseIntent(incorrect, 'ZapTweaks', changed, merge, stable.version), /project version differs/);
});
