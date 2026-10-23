// Runs tools/build.sh, so the dev server and the browser tests always serve freshly compiled frontend code.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function build(): void {
  execFileSync(fileURLToPath(new URL('../build.sh', import.meta.url)), { stdio: 'inherit' });
}
