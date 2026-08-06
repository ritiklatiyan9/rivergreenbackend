import test from 'node:test';
import assert from 'node:assert/strict';

import { APP_FEATURES, buildAppMapPrompt, isAllowedRoute } from '../config/appKnowledge.js';
import { extractAgentJson } from '../services/salesAssistant.service.js';

test('every app-map route validates, so the model can emit any of them', () => {
  for (const feature of APP_FEATURES) {
    const concrete = feature.route.replace(/:([a-zA-Z]+)/g, 'abc-123');
    assert.equal(isAllowedRoute(concrete), true, `${feature.route} should be allowed`);
  }
});

test('route validation blocks anything outside the app map', () => {
  assert.equal(isAllowedRoute('/leads/bulk?utm=ai'), true);
  assert.equal(isAllowedRoute('/calls/lead/9f8e7d6c'), true);
  assert.equal(isAllowedRoute('/unknown-page'), false);
  assert.equal(isAllowedRoute('https://evil.example.com'), false);
  assert.equal(isAllowedRoute('//evil.example.com'), false);
  assert.equal(isAllowedRoute('javascript:alert(1)'), false);
  assert.equal(isAllowedRoute(''), false);
  assert.equal(isAllowedRoute(null), false);
});

test('app map prompt lists the import flow the assistant must teach', () => {
  const prompt = buildAppMapPrompt();
  assert.match(prompt, /\/leads\/bulk/);
  assert.match(prompt, /Download Template/);
  assert.match(prompt, /\/calls\/scheduled/);
});

test('agent JSON extraction handles plain, fenced, and prose-wrapped output', () => {
  const object = { answer: 'ok', actions: [], lead_ids: [] };
  const json = JSON.stringify(object);
  assert.deepEqual(extractAgentJson(json), object);
  assert.deepEqual(extractAgentJson('```json\n' + json + '\n```'), object);
  assert.deepEqual(extractAgentJson('Here you go: ' + json), object);
  assert.equal(extractAgentJson('no json here'), null);
  assert.equal(extractAgentJson(''), null);
  assert.equal(extractAgentJson('[1,2]'), null);
});
