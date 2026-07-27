import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  browserAcceptLanguages,
  browserPartitionForWorkspace,
  standardChromeUserAgent,
} from './browserProfile.js';

test('workspace browser profiles are stable across chat sessions', () => {
  const root = path.join(path.sep, 'workspace', 'project-a');
  assert.equal(
    browserPartitionForWorkspace(root),
    browserPartitionForWorkspace(root),
  );
});

test('workspace browser profiles isolate projects without exposing local paths', () => {
  const first = browserPartitionForWorkspace(path.join(path.sep, 'workspace', 'project-a'));
  const second = browserPartitionForWorkspace(path.join(path.sep, 'workspace', 'project-b'));
  assert.notEqual(first, second);
  assert.match(first, /^persist:brainrouter-browser-[a-f0-9]{24}$/);
  assert.doesNotMatch(first, /workspace|project/i);
});

test('browser locale produces one stable ordered Accept-Language value', () => {
  assert.equal(browserAcceptLanguages('en_AU'), 'en-AU,en');
  assert.equal(browserAcceptLanguages('fr'), 'fr');
  assert.equal(browserAcceptLanguages('  zh-hant-tw  '), 'zh-hant-TW,zh');
  assert.equal(browserAcceptLanguages('not a locale'), 'en-US,en');
});

test('browser user agent follows the host platform without application tokens', () => {
  const mac = standardChromeUserAgent('140.0.0.0', 'darwin');
  const windows = standardChromeUserAgent('140.0.0.0', 'win32');
  assert.match(mac, /Macintosh.*Chrome\/140\.0\.0\.0/);
  assert.match(windows, /Windows NT 10\.0.*Chrome\/140\.0\.0\.0/);
  assert.doesNotMatch(mac, /Electron|BrainRouter/i);
});
