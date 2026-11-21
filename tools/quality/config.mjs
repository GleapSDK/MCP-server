// The MCP server half of the quality check: limits, scope and names from .claude/rules/code-conventions.md.
import { basename, dirname } from 'node:path';

export const LIMITS = {
  // A new file over fileLines is a warning, over newFileLines an error. An existing file over fileLines may not grow.
  fileLines: 400,
  newFileLines: 700,
  functionLines: 80,
  positionalParams: 2,
  // Growth up to this in a file or function already over its limit is a note, not a failure.
  smallGrowthLines: 10,
  lineChars: 160,
  // This share of a new file found in what the change removed elsewhere makes it moved code.
  movedShare: 0.9,
  // This share of a file in literal tables makes it data, with no line limit.
  dataShare: 0.9,
  dataMinLines: 50,
};

// The folders whose files carry a role in their name. Every other file under src/ is a plain camelCase module.
const ROLE_OF_FOLDER = { 'src/tools': 'tool', 'src/schemas': 'schema', 'src/prompts': 'prompts' };

const OUT_OF_SCOPE = [/\.test\.[cm]?[jt]sx?$/, /\.d\.[cm]?ts$/, /\.generated\.[cm]?[jt]sx?$/];
const FIXTURE = [/(^|\/)fixtures\//, /\.fixtures?\.[cm]?[jt]sx?$/];

const NAME_PART = /^[a-z][A-Za-z0-9]*$/;

const fileNameProblem = ({ path }) => {
  const role = ROLE_OF_FOLDER[dirname(path)];
  const wanted = role
    ? `a file in ${dirname(path)}/ is <area>.${role}.ts, the area camelCase`
    : 'a file is <name>.ts, the name camelCase';
  if (!path.endsWith('.ts')) return wanted;
  const parts = basename(path, '.ts').split('.');
  if (role) return parts.length === 2 && parts[1] === role && NAME_PART.test(parts[0]) ? null : wanted;
  return parts.length === 1 && NAME_PART.test(parts[0]) ? null : wanted;
};

const folderNameProblem = (folder) =>
  NAME_PART.test(basename(folder)) ? null : 'a new folder is lowercase, or camelCase when one word is not enough';

// Schemas are declarations and prompts are text: the tool contract test covers how they reach a client.
const testCandidates = ({ path, facts }) => {
  if (!path.endsWith('.ts') || /^src\/(schemas|prompts)\//.test(path) || !facts.functions.size) return null;
  return [path.replace(/\.ts$/, '.test.ts')];
};

const URL_LIKE = /(^|\.)(location|url|uri|base|parsed|link|\w*(Url|URL|Uri|Location))$|^new URL\(/;
const URL_PROPERTIES = new Set(['origin', 'protocol', 'hostname', 'host', 'pathname']);

// One job, one system: the losing side of the table in .claude/rules/code-conventions.md.
const ONE_SYSTEM_BANS = [
  {
    rule: 'http-client-import',
    module: /^(node-fetch|got|superagent|undici|ky)(\/|$)/,
    fix: 'Reach the Gleap API through gleapGet, gleapGetData, gleapPost, gleapPut or gleapDelete in src/utils/api.ts.',
  },
  { rule: 'jwt-library-import', module: /^(jsonwebtoken|jwt-decode)(\/|$)/, fix: 'Use jose, as src/auth/jwtVerifier.ts does.' },
  {
    rule: 'validation-library-import',
    module: /^(joi|yup|ajv|class-validator|superstruct|valibot)(\/|$)/,
    fix: 'Describe the input as a zod schema in src/schemas/: the SDK validates it and lists it to clients.',
  },
];

export const config = {
  limits: LIMITS,
  isInScope: (path) => /^src\/.*\.[cm]?[jt]sx?$/.test(path) && !OUT_OF_SCOPE.some((pattern) => pattern.test(path)),
  // Fixtures have no line limit and no name or test rule. Every other rule still applies to them.
  isFixture: (path) => FIXTURE.some((pattern) => pattern.test(path)),
  registryFiles: new Set(),
  isModelFile: () => false,
  isParamsExemptFile: () => false,
  genericFileNames: new Set(['index', 'types', 'utils', 'helpers', 'controller', 'model']),
  defaultExports: { isExemptFile: () => false },
  fixes: {
    'default-export': 'Use a named export.',
    'console-log':
      'Remove it: tools do not log. A failure the operator must see is console.error, an expected refusal console.warn, with the [gleap-mcp] prefix and no arguments, keys or customer text.',
    ...Object.fromEntries(ONE_SYSTEM_BANS.map(({ rule, fix }) => [rule, fix])),
  },
  extraCounters: ONE_SYSTEM_BANS.map(({ rule }) => rule),
  bannedImports: ONE_SYSTEM_BANS,
  // These fire too often on code that cannot avoid them: an `as` often narrows what the SDK or the API leaves open, and
  // most string comparisons compare a value the Gleap API owns. any, long-line and needs-test warn only until the check
  // is required. Comment stamps only warn while old comments still carry them for new ones to copy.
  warningRules: new Set(['string-compare', 'type-assertion', 'any', 'long-line', 'needs-test', 'comment-attribution', 'comment-date']),
  // Until the check is required, growth of old code warns too. A new file over newFileLines still fails.
  legacySizeGrowthWarns: true,
  stringExemptions: {
    // `typeof` and the empty string are exempt in the core. Everything here needs a URL receiver.
    isExempt: ({ name, receiver }) => URL_PROPERTIES.has(name) && URL_LIKE.test(receiver),
  },
  fileNameProblem,
  folderNameProblem,
  testCandidates,
};
