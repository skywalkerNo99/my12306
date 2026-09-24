const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Exercise the actual URL gate without starting Electron or opening real user data.
const source = fs.readFileSync(path.join(__dirname, '../light/main.cjs'), 'utf8');
const gate = source.slice(source.indexOf('function validUrl'), source.indexOf('function loginOptions'));
const sandbox = { URL, settings: { url: 'https://example.org:4200/my12306/' } };
vm.createContext(sandbox); vm.runInContext(gate, sandbox);
test('remote client requires HTTPS and isolates navigation to its configured path', () => {
  assert.equal(sandbox.validUrl('https://example.org:4200/my12306'), 'https://example.org:4200/my12306/');
  for (const value of ['http://example.org/', 'file:///tmp/test', 'https://user:pass@example.org/', 'https://example.org/#token']) assert.throws(() => sandbox.validUrl(value));
  assert.ok(sandbox.allowed('https://example.org:4200/my12306/#/plans'));
  for (const value of ['https://evil.org/my12306/', 'https://example.org:4200/prefect/', 'https://example.org:4200/my12306-evil/', 'https://example.org:4200/my12306/../prefect/']) assert.equal(sandbox.allowed(value), false);
});
test('light package does not ship a server or browser resources', () => {
  process.env.MY12306_SIGNING = 'unsigned';
  const config = require('../electron-builder-light.cjs');
  assert.deepEqual(config.extraResources, []);
  assert.deepEqual(config.files, ['main/**', 'package.json']);
  assert.equal(config.appId, 'cn.my12306.light');
});
