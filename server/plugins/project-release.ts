import type { Plugin } from 'vite';
import { PROJECT_LATEST_RELEASE_ROUTE, PROJECT_LATEST_RELEASE_URL, PROJECT_REPOSITORY_URL } from '../../shared/project-repository.ts';

export function projectReleasePlugin(): Plugin {
  return {
    name: 'zuoren-project-release',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'GET' || req.url !== PROJECT_LATEST_RELEASE_ROUTE) return next();

        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        try {
          // GitHub exposes the latest stable release as a redirect, without the REST API quota.
          const response = await fetch(PROJECT_LATEST_RELEASE_URL, {
            method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5_000),
          });
          const tagUrl = response.headers.get('location');
          const tagPrefix = `${PROJECT_REPOSITORY_URL}/releases/tag/`;
          if (response.status !== 302 || !tagUrl?.startsWith(tagPrefix)) throw new Error('Missing release tag');
          const tag = decodeURIComponent(tagUrl.slice(tagPrefix.length));
          res.end(JSON.stringify({ tag_name: tag }));
        } catch {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: 'Unable to fetch the latest release tag from GitHub' }));
        }
      });
    },
  };
}
