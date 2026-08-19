/** `/api/mark` - produce one invisibly marked copy of a document per recipient.
 *
 * Synchronous and stateless, like `/api/sanitize`. The documents people mark
 * are contracts, drafts and unreleased reports; keeping a copy of one on our
 * side would create exactly the leak the user is trying to trace.
 */

import type { MarkResult } from '@wf/shared';
import { Hono } from 'hono';
import { getConfig } from '../lib/config';
import { badRequest } from '../lib/errors';
import { createSpaceClient } from '../lib/space';
import type { AppContext } from '../types';

export const markRoutes = new Hono<AppContext>();

const CHANNELS = ['tag_characters', 'variation_selectors', 'zero_width_binary'] as const;
const MAX_RECIPIENTS = 100;

markRoutes.post('/', async (c) => {
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

  const recipients = record.recipients;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw badRequest('"recipients" must be a non-empty array');
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw badRequest(`"recipients" is limited to ${MAX_RECIPIENTS} entries`);
  }
  if (!recipients.every((r) => typeof r === 'string' && r.trim().length > 0)) {
    throw badRequest('every recipient must be a non-empty string');
  }
  if (new Set(recipients).size !== recipients.length) {
    throw badRequest('recipients must be distinct, otherwise the copies cannot be told apart');
  }

  const template = record.template ?? '{recipient}';
  if (typeof template !== 'string' || template.length > 128) {
    throw badRequest('"template" must be a string of at most 128 characters');
  }

  const channel = record.channel ?? 'tag_characters';
  if (typeof channel !== 'string' || !CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
    throw badRequest(`"channel" must be one of: ${CHANNELS.join(', ')}`);
  }

  const repeat = record.repeat ?? 2;
  if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 1 || repeat > 20) {
    throw badRequest('"repeat" must be an integer between 1 and 20');
  }

  const space = createSpaceClient(
    c.env.ANALYSIS_SPACE_URL,
    c.env.ANALYSIS_SPACE_TOKEN,
    config.spaceTimeoutMs,
  );

  const result: MarkResult = await space.mark(
    { text, recipients: recipients as string[], template, channel, repeat },
    c.get('requestId'),
  );

  return c.json(result);
});
