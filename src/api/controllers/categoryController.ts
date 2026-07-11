import { Router } from 'express';
import { isAppCategoryName, listAll, setOverride } from '../../store/appCategoryLabelStore.js';

/**
 * 2d — operator-facing read + manual-override surface for app-category labels, mounted under
 * /v1 (operator-authed via requireAuthenticatedOperator + enforceRbacPolicy in app.ts). Powers
 * the ops-console Categories view: list every resolved/pending token and correct wrong ones.
 */
export function createCategoryController(): Router {
  const router = Router();

  // GET /v1/categories — full listing (newest-updated first).
  router.get('/', async (_req, res, next) => {
    try {
      const labels = await listAll();
      res.json({ categories: labels, count: labels.length });
    } catch (error) {
      next(error);
    }
  });

  // PATCH /v1/categories/:token — operator override; always wins over curated/llm.
  router.patch('/:token', async (req, res, next) => {
    try {
      const token = typeof req.params.token === 'string' ? req.params.token : '';
      const category = (req.body ?? {}).category;
      if (!isAppCategoryName(category)) {
        res.status(400).json({ error: 'category must be one of the 8 AppCategory names' });
        return;
      }
      await setOverride(token, category);
      res.json({ ok: true, token: token.trim().toLowerCase(), category, source: 'override' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
