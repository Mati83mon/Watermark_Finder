'use client';

import { useEffect, useState } from 'react';
import type { Capabilities } from '@wf/shared';
import { api } from '@/lib/api';

/**
 * Header indicator for engine reachability.
 *
 * A free Space sleeps after inactivity and takes tens of seconds to wake, so
 * "asleep" is a normal state worth showing rather than an error to hide.
 */
export function EngineStatus() {
  const [state, setState] = useState<'loading' | 'ok' | 'down'>('loading');
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .capabilities(controller.signal)
      .then((capabilities: Capabilities) => {
        setState(capabilities.engine_reachable ? 'ok' : 'down');
        setVersion(capabilities.engine_version);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('down');
      });
    return () => controller.abort();
  }, []);

  const presentation = {
    loading: { dot: 'bg-muted', text: 'Checking engine…' },
    ok: { dot: 'bg-ok', text: `Engine ready${version ? ` · v${version}` : ''}` },
    down: { dot: 'bg-warn', text: 'Engine asleep — first analysis may take a minute' },
  }[state];

  return (
    <span className="flex items-center gap-2 text-xs text-muted" role="status">
      <span aria-hidden className={`h-2 w-2 rounded-full ${presentation.dot}`} />
      {presentation.text}
    </span>
  );
}
