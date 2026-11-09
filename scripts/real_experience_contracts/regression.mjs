/** Controller-owned runner. A script must finish; exits are not assertions.
 * This prevents accidental classification mistakes, not hostile code in a shared
 * OS namespace. External isolation is still required for adversarial submissions.
 */
import { AssertionError } from 'node:assert';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
process.argv = [process.execPath, target, ...process.argv.slice(3)];
const denyExit = () => { throw new Error('Direct process exit is not permitted in an acceptance script'); };
process.exit = denyExit;
process.reallyExit = denyExit;
syncBuiltinESMExports();
try {
  await import(pathToFileURL(target).href);
  if (process.exitCode !== undefined && process.exitCode !== 0) {
    throw new Error('Script set a failure exit code without an uncaught assertion');
  }
} catch (error) {
  console.error(error);
  if (error instanceof AssertionError) {
    // Last, so bounded stderr retention cannot drop the classification marker.
    console.error('PRALE_REGRESSION_ASSERTION');
    process.exitCode = 42;
  } else {
    process.exitCode = 1;
  }
}
