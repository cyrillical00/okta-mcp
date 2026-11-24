import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveScopes } from '../src/config.js';

const ALL = [
  'okta.users.read',
  'okta.users.manage',
  'okta.groups.read',
  'okta.groups.manage',
  'okta.apps.read',
  'okta.apps.manage',
  'okta.logs.read',
  'okta.policies.read',
  'okta.factors.read',
  'okta.factors.manage',
  'okta.roles.read',
  'okta.devices.read',
];

test('with writes enabled the configured scopes are requested unchanged', () => {
  assert.deepEqual(effectiveScopes(ALL, true), ALL);
});

test('with writes disabled no manage scope is requested', () => {
  const scopes = effectiveScopes(ALL, false);
  assert.deepEqual(scopes, [
    'okta.users.read',
    'okta.groups.read',
    'okta.apps.read',
    'okta.logs.read',
    'okta.policies.read',
    'okta.factors.read',
    'okta.roles.read',
    'okta.devices.read',
  ]);
  assert.ok(scopes.every(scope => !scope.endsWith('.manage')));
});
