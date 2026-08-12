/** Hono application: route table and middleware wiring. */

import { Hono } from 'hono';
import { analysesRoutes } from './routes/analyses';
import { metaRoutes } from './routes/meta';
import { reportsRoutes } from './routes/reports';
import { uploadsRoutes } from './routes/uploads';
import type { AppContext } from './types';
import { cors, errorHandler, notFoundHandler, rateLimit, requestId, requireWorkspace } from './middleware';

export function createApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();

  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.use('*', requestId);
  app.use('*', cors);
  app.use('/api/*', rateLimit);

  // Public: no workspace token required.
  app.route('/api', metaRoutes);

  // Everything below is scoped to a workspace.
  app.use('/api/analyses/*', requireWorkspace);
  app.use('/api/uploads/*', requireWorkspace);
  app.use('/api/reports/*', requireWorkspace);

  app.route('/api/analyses', analysesRoutes);
  app.route('/api/uploads', uploadsRoutes);
  app.route('/api/reports', reportsRoutes);

  app.get('/', (c) =>
    c.json({
      name: 'watermark-finder-api',
      version: '1.0.0',
      docs: 'https://github.com/Mati83mon/Watermark_Finder/blob/main/docs/api-spec.md',
      endpoints: [
        'GET    /api/health',
        'GET    /api/capabilities',
        'POST   /api/session',
        'GET    /api/stats',
        'POST   /api/analyses',
        'GET    /api/analyses',
        'GET    /api/analyses/:id',
        'GET    /api/analyses/:id/segments',
        'GET    /api/analyses/:id/text',
        'DELETE /api/analyses/:id',
        'POST   /api/uploads',
        'POST   /api/reports',
        'GET    /api/reports',
        'GET    /api/reports/:id',
        'DELETE /api/reports/:id',
      ],
    }),
  );

  return app;
}
