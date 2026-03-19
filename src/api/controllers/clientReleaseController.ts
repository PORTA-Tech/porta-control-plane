import { Router } from 'express';
import { readLatestWindowsClientRelease } from '../../core/clientReleaseService.js';

export function createClientReleaseController(): Router {
  const router = Router();

  router.get('/windows/latest', (_req, res) => {
    const manifest = readLatestWindowsClientRelease();
    if (!manifest) {
      res.status(404).json({
        error_code: 'WINDOWS_RELEASE_NOT_CONFIGURED',
        message: 'No Windows release manifest is configured on this control-plane node.'
      });
      return;
    }

    res.json(manifest);
  });

  return router;
}
