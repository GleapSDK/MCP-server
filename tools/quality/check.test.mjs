// node --test tools/quality/check.test.mjs (npm run test:quality). The shared core's cases, then what only this
// repo's config decides.
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { config, LIMITS } from './config.mjs';
import { defineCoreCases } from './core.cases.mjs';
import { checkChange, checkChanges } from './rules.mjs';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '../..');

defineCoreCases({
  describe,
  it,
  afterAll: after,
  config,
  LIMITS,
  checkChange,
  checkChanges,
  toolDir: TOOL_DIR,
  repoRoot: REPO_ROOT,
  toolRelative: 'tools/quality',
  pathFor: (name) => `src/utils/${name}.ts`,
});

// Detection is tested with every rule at full strength. The core cases pin which rules only warn.
const strict = { ...config, warningRules: new Set(), legacySizeGrowthWarns: false };
const report = (change, pathExists = () => true) =>
  checkChange({ change: { isNewPath: change.before == null, newFolders: [], ...change }, config: strict, pathExists });
const rulesOf = (change, pathExists) => report(change, pathExists).violations.map(({ rule }) => rule);

const logic = 'export const run = (a: number) => a + 1;';

describe('scope', () => {
  for (const path of ['src/index.ts', 'src/tools/ticket.tool.ts', 'src/utils/sessionScope.ts', 'src/auth/jwtVerifier.ts']) {
    it(`checks ${path}`, () => assert.ok(config.isInScope(path), path));
  }
  for (const path of ['src/utils/sessionScope.test.ts', 'tests/tool-contract.test.ts', 'tools/quality/rules.mjs', 'scripts/test/run.mjs', 'build/index.js']) {
    it(`leaves out ${path}`, () => assert.ok(!config.isInScope(path), path));
  }
});

describe('file names', () => {
  for (const path of ['src/tools/emailTemplates.tool.ts', 'src/schemas/emailTemplates.schema.ts', 'src/prompts/kaiCode.prompts.ts', 'src/utils/retryBudget.ts', 'src/auth/scopeCheck.ts']) {
    it(`green: ${path}`, () => assert.deepEqual(rulesOf({ path, before: null, after: logic }), []));
  }
  for (const path of ['src/tools/email-templates.tool.ts', 'src/tools/emailTemplates.ts', 'src/utils/retry_budget.ts', 'src/utils/retryBudget.tool.ts', 'src/schemas/emailTemplates.tool.ts']) {
    it(`red: ${path}`, () => assert.ok(rulesOf({ path, before: null, after: logic }).includes('file-name')));
  }
  it('red: a new generic name', () => assert.ok(rulesOf({ path: 'src/utils/helpers.ts', before: null, after: logic }).includes('generic-file-name')));
  it('red: a new folder that is not camelCase', () =>
    assert.ok(rulesOf({ path: 'src/rate-limits/budget.ts', before: null, after: logic, newFolders: ['src/rate-limits'] }).includes('folder-name')));
});

describe('needs-test', () => {
  const missing = () => false;
  it('red: a new module with functions and no test next to it', () =>
    assert.ok(rulesOf({ path: 'src/utils/retryBudget.ts', before: null, after: logic }, missing).includes('needs-test')));
  it('green: the test is next to it', () =>
    assert.ok(!rulesOf({ path: 'src/utils/retryBudget.ts', before: null, after: logic }, (path) => path === 'src/utils/retryBudget.test.ts').includes('needs-test')));
  it('green: a schema or a prompt needs none', () => {
    for (const path of ['src/schemas/emailTemplates.schema.ts', 'src/prompts/kaiCode.prompts.ts']) {
      assert.ok(!rulesOf({ path, before: null, after: logic }, missing).includes('needs-test'), path);
    }
  });
});

describe('one job, one system', () => {
  for (const [module, rule] of [
    ['node-fetch', 'http-client-import'],
    ['undici', 'http-client-import'],
    ['jsonwebtoken', 'jwt-library-import'],
    ['joi', 'validation-library-import'],
  ]) {
    it(`red: a new import of ${module}`, () =>
      assert.ok(rulesOf({ path: 'src/utils/retryBudget.ts', before: logic, after: `import x from '${module}';\n${logic}` }).includes(rule)));
  }
  it('green: axios, jose and zod', () =>
    assert.deepEqual(
      rulesOf({ path: 'src/utils/retryBudget.ts', before: logic, after: `import axios from 'axios';\nimport { jwtVerify } from 'jose';\nimport { z } from 'zod';\n${logic}` }),
      []
    ));
});
