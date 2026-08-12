/** `/api/uploads` - accept a document into R2 and hand back an id. */

import { Hono } from 'hono';
import { getConfig } from '../lib/config';
import { newId } from '../lib/crypto';
import { Database } from '../lib/db';
import { badRequest, payloadTooLarge } from '../lib/errors';
import { Storage, uploadKey } from '../lib/storage';
import type { AppContext } from '../types';
import { sanitizeFilename } from '../lib/validation';

const ALLOWED_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.log',
  '.rst',
  '.json',
  '.html',
  '.htm',
  '.pdf',
  '.docx',
]);

/**
 * The shape this route needs from an uploaded file.
 *
 * Declared structurally rather than as `instanceof File`: the Workers runtime,
 * Node and the test environment each expose their own File constructor, so an
 * identity check on the class is unreliable across them.
 */
interface UploadedFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isUploadedFile(value: unknown): value is UploadedFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<UploadedFile>;
  return typeof candidate.arrayBuffer === 'function' && typeof candidate.name === 'string';
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export const uploadsRoutes = new Hono<AppContext>();

uploadsRoutes.post('/', async (c) => {
  const config = getConfig(c.env);
  const workspace = c.get('workspace');

  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    throw badRequest('Send the file as multipart/form-data with a "file" field');
  }

  const form = await c.req.formData();
  const entry: unknown = form.get('file');
  if (!isUploadedFile(entry)) {
    throw badRequest('No "file" field in the request');
  }
  const file = entry;

  const filename = sanitizeFilename(file.name) ?? 'upload.txt';
  const extension = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw badRequest(
      `Unsupported file type "${extension || 'none'}". Allowed: ${[...ALLOWED_EXTENSIONS]
        .sort()
        .join(', ')}`,
    );
  }

  // `file.size` is reported by the client, so the authoritative check is on the
  // bytes actually read.
  if (file.size > config.maxUploadBytes) {
    throw payloadTooLarge(`File is ${file.size} bytes; the limit is ${config.maxUploadBytes}`, {
      size: file.size,
      limit: config.maxUploadBytes,
    });
  }

  const body = await file.arrayBuffer();
  if (body.byteLength === 0) throw badRequest('The uploaded file is empty');
  if (body.byteLength > config.maxUploadBytes) {
    throw payloadTooLarge(
      `File is ${body.byteLength} bytes; the limit is ${config.maxUploadBytes}`,
      { size: body.byteLength, limit: config.maxUploadBytes },
    );
  }

  const uploadId = newId('u');
  const key = uploadKey(workspace.id, uploadId, filename);
  const storage = new Storage(c.env.BUCKET, c.env.CACHE);
  await storage.putUpload(key, body, file.type || 'application/octet-stream', {
    workspace: workspace.id,
    upload: uploadId,
    filename,
  });

  await new Database(c.env.DB).recordEvent(
    'upload.created',
    `${filename} (${body.byteLength} bytes)`,
    workspace.id,
    null,
  );

  return c.json(
    {
      upload_id: uploadId,
      filename,
      size: body.byteLength,
      content_type: file.type || 'application/octet-stream',
    },
    201,
  );
});
