/**
 * POST /api/download-request — the porta-website download form (2026-08-26).
 *
 * The response shape is the website's, not this repo's usual `{ error_code, message }`: the page
 * reads `error` and `code` on failure and `message` on success, and it now refuses any response
 * that is not a JSON object. That refusal exists because a static host answering an empty 200
 * used to render as success, so this endpoint always answers with a real JSON body.
 */
import { Router } from 'express';
import {
  checkDownloadRequestRateLimit,
  pruneDownloadRequestRateLimit,
  resolveClientIp
} from '../../core/downloadRequestRateLimit.js';
import {
  sendDownloadRequestEmails,
  validateDownloadRequest,
  type DownloadRequestInput
} from '../../core/downloadRequestService.js';

export function createDownloadRequestController(): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    pruneDownloadRequestRateLimit();

    const ip = resolveClientIp(req.headers, req.socket?.remoteAddress ?? undefined);
    const limit = checkDownloadRequestRateLimit(ip);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      res.status(429).json({
        ok: false,
        error: 'Too many requests from here. Please try again shortly.',
        code: 'rate_limited'
      });
      return;
    }

    const validation = validateDownloadRequest(req.body as DownloadRequestInput | null);
    if (!validation.ok) {
      res.status(400).json({ ok: false, error: validation.error, code: 'invalid_request' });
      return;
    }

    if (!process.env.RESEND_API_KEY) {
      res.status(503).json({
        ok: false,
        error: 'The request service is not configured right now.',
        code: 'email_not_configured'
      });
      return;
    }

    let result;
    try {
      result = await sendDownloadRequestEmails(validation.value);
    } catch (error) {
      console.error(
        '[downloadRequest] send threw:',
        error instanceof Error ? error.message : String(error)
      );
      res.status(502).json({
        ok: false,
        error: 'We could not send your request right now. Please try again.',
        code: 'send_failed'
      });
      return;
    }

    if (!result.ok) {
      res.status(502).json({
        ok: false,
        error: 'We could not send your request right now. Please try again.',
        code: 'send_failed'
      });
      return;
    }

    res.status(200).json({
      ok: true,
      message: 'Thanks. Check your email — we will be in touch shortly.'
    });
  });

  return router;
}
