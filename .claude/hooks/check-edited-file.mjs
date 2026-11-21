// After every edit: the quality check on that one file, so the agent sees problems at once. The typecheck and the
// tests wait for the stop hook.
import { join } from 'node:path';

import { projectDirOf, runEditHook } from '../../tools/quality/hooks.mjs';

const projectDir = projectDirOf(import.meta.url);

await runEditHook({ projectDir, toolPath: join(projectDir, 'tools/quality/check.mjs') });
