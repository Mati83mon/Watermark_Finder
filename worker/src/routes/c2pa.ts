/** `/api/c2pa` - read the C2PA content credential embedded in a file.
 *
 * Stateless like `/api/sanitize` and `/api/mark`: the file is streamed to the
 * engine, inspected, and forgotten. Nothing reaches R2 or D1.
 *
 * Unlike `/api/uploads` this accepts any file type. C2PA covers PDFs, images,
 * audio and video, and restricting it to the text formats the analyser can
 * read would throw away most of the standard's value.
 */

import type { C2paResult } from '@wf/shared';
import { Hono } from 'hono';
import { getConfig } from '../lib/config';
import { badRequest } from '../lib/errors';
import { createSpaceClient } from '../lib/space';
import type { AppContext } from '../types';
import { isUploadedFile, sanitizeFilename } from '../lib/validation';

export const c2paRoutes = new Hono<AppContext>();

c2paRoutes.post('/', async (c) => {
  const config = getConfig(c.env);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest('Send the file as multipart/form-data with a "file" field');
  }

  const entry: unknown = form.get('file');
  if (!isUploadedFile(entry)) {
    throw badRequest('No "file" field in the request');
  }
  const file = entry;
  if (file.size === 0) {
    throw badRequest('the file is empty');
  }
  if (file.size > config.maxUploadBytes) {
    throw badRequest(`the file exceeds the ${config.maxUploadBytes} byte limit`);
  }

  const space = createSpaceClient(
    c.env.ANALYSIS_SPACE_URL,
    c.env.ANALYSIS_SPACE_TOKEN,
    config.spaceTimeoutMs,
  );

  const result: C2paResult = await space.c2pa(
    new Blob([await file.arrayBuffer()], { type: file.type || 'application/octet-stream' }),
    sanitizeFilename(file.name) ?? 'upload',
    c.get('requestId'),
  );

  return c.json(result);
});
