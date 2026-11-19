// The packaged version nails cwd to the .env.local path of userData:keystore and the default upload directory is anchored in
// process.cwd() (module top-level evaluation), use chdir once to let the two naturally fall into the user-writable area, server side
// Zero modifications. Must be evaluated before the import chain of embedded-server - keep this module in main.ts
// The first import (ESM is executed depth first in declaration order). dev (unpackaged) inherits the startup cwd (worktree root).
import { mkdirSync } from 'node:fs';
import { app } from 'electron';
import { isAbsolute } from 'node:path';

// Packaged smoke tests must not write the user's live profile or render caches.
const smokeUserData = process.env.CC_SMOKE_USER_DATA_DIR;
if (process.env.CC_SMOKE === '1' && smokeUserData) {
  if (!isAbsolute(smokeUserData)) throw new Error('Smoke user data path must be absolute');
  mkdirSync(smokeUserData, { recursive: true });
  app.setPath('userData', smokeUserData);
}

if (app.isPackaged) {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
}
