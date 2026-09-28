import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileTemplate } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { renderToString } from '@vue/server-renderer';

test('calendar ticket shows its train and departure clock', async () => {
  const source = readFileSync(new URL('../../../web/src/components/CalendarTicket.vue', import.meta.url), 'utf8');
  const template = source.match(/<template>([\s\S]*?)<\/template>/)![1];
  const { code } = compileTemplate({ source: template, filename: 'CalendarTicket.vue', id: 'calendar-ticket' });
  const executable = code.replace(/import \{([\s\S]*?)\} from "vue"/, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'function render');
  const render = new Function('Vue', `${executable}; return render;`)(Vue);
  const html = await renderToString(Vue.createSSRApp({ props: ['ticket'], render }, { ticket: { trainCode: 'G1716', travelDateTime: '2026-09-28 13:03', fromStation: '常州北', toStation: '信阳东' } }));
  assert.match(html, /G1716/);
  assert.match(html, /13:03/);
});
