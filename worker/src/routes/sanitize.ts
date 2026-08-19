/** `/api/sanitize` - strip covert-channel characters from a document.
 *
 * Synchronous and stateless, unlike `/api/analyses`: nothing is written to D1
 * or R2. Removing hidden characters is a pure function of the input, the user
 * usually wants the result immediately, and storing a document somebody is
 * cleaning precisely so they can pass it on would be the wrong instinct.
 */

import type { SanitizeResult } from '@wf/shared';
import { Hono } from 'hono';
import { getConfig } from '../lib/config';
import { badRequest } from '../lib/errors';
import { createSpaceClient } from '../lib/space';
import type { AppContext } from '../types';

export const sanitizeRoutes = new Hono<AppContext>();

const LEVELS = ['safe', 'aggressive'] as const;

sanitizeRoutes.post('/', async (c) => {
  const config = getConfig(c.env);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('Request body must be a JSON object');
  }
  if (typeof body !== 'object' || body === null) {
    throw badRequest('Request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const text = record.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw badRequest('"text" is required');
  }
  if (text.length > config.maxTextChars) {
    throw badRequest(`"text" exceeds the ${config.maxTextChars} character limit`);
  }

  const level = record.level ?? 'safe';
  if (typeof level !== 'string' || !LEVELS.includes(level as (typeof LEVELS)[number])) {
    throw badRequest(`"level" must be one of: ${LEVELS.join(', ')}`);
  }

  const normalizeHomoglyphs = record.normalize_homoglyphs ?? false;
  if (typeof normalizeHomoglyphs !== 'boolean') {
    throw badRequest('"normalize_homoglyphs" must be a boolean');
  }

  const space = createSpaceClient(
    c.env.ANALYSIS_SPACE_URL,
    c.env.ANALYSIS_SPACE_TOKEN,
    config.spaceTimeoutMs,
  );

  const result: SanitizeResult = await space.sanitize(
    text,
    level,
    normalizeHomoglyphs,
    c.get('requestId'),
  );

  return c.json(result);
});
