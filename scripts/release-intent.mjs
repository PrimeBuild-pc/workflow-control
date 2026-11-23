import assert from 'node:assert/strict';

const filename = 'release-intent.json';
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const distribution = new Map([
  ['LightCrosshair', ['winget', 'chocolatey']],
  ['TweakHub', ['winget']],
  ['ThreadPilot', ['winget', 'chocolatey']],
  ['SockTuner', []],
  ['ZapTweaks', []],
  ['NeuroTune', []],
  ['discord-theme-launcher', []],
]);
const betaOnly = new Set(['NeuroTune', 'discord-theme-launcher']);
const versionFiles = new Map([
  ['LightCrosshair', 'LightCrosshair/LightCrosshair.csproj'],
  ['TweakHub', 'TweakHub.csproj'],
  ['ThreadPilot', 'ThreadPilot.csproj'],
  ['SockTuner', 'Directory.Build.props'],
  ['ZapTweaks', 'pubspec.yaml'],
  ['NeuroTune', 'package.json'],
  ['discord-theme-launcher', 'package.json'],
]);

function xmlVersion(contents, field) {
  const matches = [...contents.matchAll(new RegExp(`<${field}>([^<]+)</${field}>`, 'gu'))];
  assert.ok(matches.length <= 1, `Expected at most one ${field} in the project file.`);
  return matches[0]?.[1].trim();
}

function readVersion(repository, contents) {
  if (betaOnly.has(repository)) return JSON.parse(contents).version;
  if (repository === 'ZapTweaks') {
    const entries = [...contents.matchAll(/^version:[ \t]+([^\s+#]+)(?:\+[^\s#]+)?[ \t]*(?:#[^\r\n]*)?\r?$/gmu)];
    assert.equal(entries.length, 1, 'Expected one pubspec version.');
    return entries[0][1];
  }
  const version = xmlVersion(contents.replace(/<!--[\s\S]*?-->/gu, ''), 'Version');
  if (version || repository !== 'TweakHub') return version;
  const prefix = xmlVersion(contents, 'VersionPrefix');
  const suffix = xmlVersion(contents, 'VersionSuffix');
  return suffix ? `${prefix}-${suffix}` : prefix;
}

async function readTextFile(get, path, revision, maxBytes) {
  const blob = await get(`contents/${path}?ref=${revision}`);
  assert.equal(blob.type, 'file');
  assert.equal(blob.encoding, 'base64');
  assert.ok(blob.size > 0 && blob.size <= maxBytes, `Unexpected file size for ${path}.`);
  const bytes = Buffer.from(blob.content, 'base64');
  assert.equal(bytes.length, blob.size);
  return bytes.toString('utf8').replace(/^\uFEFF/u, '');
}

export function validateReleaseIntent(repository, explicitVersion, intent) {
  assert.ok(distribution.has(repository), 'Unknown release repository.');
  const version = versionPattern.exec(explicitVersion);
  assert.ok(version && version[0] === explicitVersion, 'Expected a release version without the v prefix.');
  assert.ok(!version[4]?.split('.').some(part => /^0[0-9]+$/u.test(part)), 'A numeric prerelease identifier has a leading zero.');
  assert.ok(intent && typeof intent === 'object' && !Array.isArray(intent), 'Expected a release intent object.');
  assert.deepEqual(Object.keys(intent).sort(), ['channels', 'type', 'version']);
  assert.equal(intent.version, explicitVersion, 'The approved version differs from the release intent.');
  assert.equal(intent.type, version[4] ? 'prerelease' : 'stable', 'Release type does not match the version.');
  if (betaOnly.has(repository)) {
    assert.match(version[4] ?? '', /^beta\.(0|[1-9][0-9]*)$/u, 'This project currently supports beta packaging only.');
  }
  assert.ok(Array.isArray(intent.channels) && intent.channels.includes('github'), 'Select the GitHub release channel.');
  const allowed = ['github', ...(intent.type === 'stable' ? distribution.get(repository) : [])];
  assert.ok(intent.channels.every(channel => allowed.includes(channel)), 'An approved channel is unsupported for this project or release type.');
  assert.equal(new Set(intent.channels).size, intent.channels.length, 'Channels must be unique.');
  return intent;
}

export async function verifyReleaseIntent(get, repository, files, testMerge, explicitVersion = '') {
  const changed = files.some(file => file.filename === filename && file.status !== 'removed');
  if (!changed) {
    assert.equal(explicitVersion, '', 'The PR must add or update release-intent.json to approve a release.');
    return null;
  }
  assert.ok(explicitVersion, 'Enter the release version to approve the changed release intent.');
  const intent = validateReleaseIntent(repository, explicitVersion,
    JSON.parse(await readTextFile(get, filename, testMerge, 4096)));
  const contents = await readTextFile(get, versionFiles.get(repository), testMerge, 131072);
  assert.equal(readVersion(repository, contents), intent.version, 'The project version differs from the release intent.');
  return intent;
}
