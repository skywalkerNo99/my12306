import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext } from 'playwright';
import { inspectSession, confirmedInvalid } from '../bot/session-check.js';

test('only an explicit false flag means logged out; transport errors remain unknown', async () => {
 for (const [response, expected] of [
  [{ok:true,status:200,body:'{"data":{"flag":true}}'},'active'],
  [{ok:true,status:200,body:'{"data":{"flag":false}}'},'invalid'],
  [{ok:false,status:503,body:''},'unknown'],
  [{ok:true,status:200,body:'<html>login</html>'},'unknown'],
  [{ok:true,status:200,body:'{}'},'unknown'],
  [null,'unknown'],
 ] as const) {
  let closed=false;
  const context={newPage:async()=>({goto:async()=>{},waitForTimeout:async()=>{},evaluate:async()=>{if(!response)throw new Error('network');return response;},close:async()=>{closed=true;}})} as unknown as BrowserContext;
  assert.equal((await inspectSession(context, new Date('2026-09-30T12:00:00+08:00'))).status,expected);
  assert.ok(closed);
 }
});
// A false checkUser flag during the nightly booking closure must not trigger
// re-login alerts; reopening must still detect genuinely expired sessions.
test('nightly false flags are inconclusive, including the Tuesday midnight closure', async () => {
 const context = { newPage: async () => ({
  goto: async () => {}, waitForTimeout: async () => {},
  evaluate: async () => ({ ok: true, status: 200, body: '{"data":{"flag":false}}' }),
  close: async () => {},
 }) } as unknown as BrowserContext;
 for (const [time, expected] of [
  ['2026-09-29T00:59:59+08:00', 'invalid'],
  ['2026-09-29T01:00:00+08:00', 'unknown'],
  ['2026-09-29T04:59:59+08:00', 'unknown'],
  ['2026-09-29T05:00:00+08:00', 'invalid'],
  ['2026-09-29T23:59:59+08:00', 'invalid'],
  ['2026-09-30T00:00:00+08:00', 'unknown'],
  ['2026-09-30T04:59:59+08:00', 'unknown'],
  ['2026-09-30T05:00:00+08:00', 'invalid'],
  ['2026-10-01T00:00:00+08:00', 'invalid'],
 ] as const) {
  assert.equal((await inspectSession(context, new Date(time))).status, expected, time);
 }
 let failures = 1;
 for (const time of ['2026-09-30T00:04:00+08:00', '2026-09-30T00:09:00+08:00']) {
  failures = confirmedInvalid(failures, await inspectSession(context, new Date(time)));
  assert.equal(failures, 0);
 }
 for (const time of ['2026-09-30T05:04:00+08:00', '2026-09-30T05:09:00+08:00']) {
  failures = confirmedInvalid(failures, await inspectSession(context, new Date(time)));
 }
 assert.equal(failures, 2);
});
test('successful checks remain active even outside booking hours', async () => {
 const context = { newPage: async () => ({
  goto: async () => {}, waitForTimeout: async () => {},
  evaluate: async () => ({ ok: true, status: 200, body: '{"data":{"flag":true}}' }),
  close: async () => {},
 }) } as unknown as BrowserContext;
 assert.equal((await inspectSession(context, new Date('2026-09-30T02:00:00+08:00'))).status, 'active');
});
test('invalidating requires consecutive explicit failures, with recovery and network failures resetting the count', () => {
 const invalid={status:'invalid',reason:'not logged in'} as const;
 assert.equal(confirmedInvalid(0,invalid),1);
 assert.equal(confirmedInvalid(1,invalid),2);
 assert.equal(confirmedInvalid(1,{status:'unknown',reason:'offline'}),0);
 assert.equal(confirmedInvalid(2,{status:'active',reason:'ok'}),0);
});
