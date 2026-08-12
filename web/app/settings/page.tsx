'use client';

import { useEffect, useState } from 'react';
import type { Capabilities } from '@wf/shared';
import {
  api,
  clearSession,
  createSession,
  DEFAULT_BASE_URL,
  getBaseUrl,
  getWorkspaceId,
  setBaseUrl,
} from '@/lib/api';
import { formatBytes } from '@/lib/format';

export default function SettingsPage() {
  const [baseUrl, setBaseUrlState] = useState('');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [health, setHealth] = useState<{ status: string; warnings: string[] } | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setBaseUrlState(getBaseUrl());
    setWorkspaceId(getWorkspaceId());
    void refresh();
  }, []);

  const refresh = async () => {
    const [capabilitiesResult, healthResult] = await Promise.allSettled([
      api.capabilities(),
      api.health(),
    ]);
    setCapabilities(capabilitiesResult.status === 'fulfilled' ? capabilitiesResult.value : null);
    setHealth(
      healthResult.status === 'fulfilled'
        ? { status: healthResult.value.status, warnings: healthResult.value.warnings ?? [] }
        : null,
    );
  };

  const saveBaseUrl = async (event: React.FormEvent) => {
    event.preventDefault();
    setBaseUrl(baseUrl);
    setBaseUrlState(getBaseUrl());
    setMessage('API base URL saved.');
    await refresh();
  };

  const resetBaseUrl = async () => {
    setBaseUrl(null);
    setBaseUrlState(getBaseUrl());
    setMessage('Reverted to the build-time default.');
    await refresh();
  };

  const newWorkspace = async () => {
    clearSession();
    const session = await createSession();
    setWorkspaceId(session.workspace_id);
    setMessage('New workspace created. Previous analyses are no longer reachable from this browser.');
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Everything here is stored in this browser only.
        </p>
      </header>

      {message ? (
        <div className="card border-ok/40">
          <p className="text-sm text-ok">{message}</p>
        </div>
      ) : null}

      <section className="card">
        <h2 className="text-base font-semibold">API endpoint</h2>
        <p className="hint mt-1">
          The Worker this frontend talks to. The default is baked in at build time; overriding it
          here lets one deployment point at a local Worker or a preview environment.
        </p>
        <form className="mt-4 space-y-3" onSubmit={saveBaseUrl}>
          <div>
            <label className="label" htmlFor="base-url">
              Base URL
            </label>
            <input
              id="base-url"
              className="input mt-1 font-mono text-xs"
              value={baseUrl}
              onChange={(event) => setBaseUrlState(event.target.value)}
              placeholder={DEFAULT_BASE_URL}
            />
            <p className="hint mt-1">Build-time default: {DEFAULT_BASE_URL}</p>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary">
              Save
            </button>
            <button type="button" className="btn-ghost" onClick={() => void resetBaseUrl()}>
              Reset to default
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Workspace</h2>
        <p className="hint mt-1">
          An anonymous namespace that keeps your analyses separate from anyone else&apos;s. There is
          no account and no personal data: the token in this browser is the only way back to your
          history, so clearing site data or switching browsers starts you fresh.
        </p>
        <p className="mt-3 break-all font-mono text-xs">{workspaceId ?? 'not created yet'}</p>
        <button type="button" className="btn-danger mt-3" onClick={() => void newWorkspace()}>
          Start a new workspace
        </button>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Service status</h2>
        {health ? (
          <>
            <p className="mt-2 text-sm">
              API: <strong>{health.status}</strong>
            </p>
            {health.warnings.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm text-warn">
                {health.warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-sm text-danger">The API did not respond.</p>
        )}

        {capabilities ? (
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row label="Engine reachable" value={capabilities.engine_reachable ? 'yes' : 'no'} />
            <Row label="Engine version" value={capabilities.engine_version ?? 'unknown'} />
            <Row label="Max characters" value={capabilities.max_chars.toLocaleString()} />
            <Row label="Max upload" value={formatBytes(capabilities.max_upload_bytes)} />
            <Row
              label="Surprisal model"
              value={capabilities.perplexity_enabled ? 'enabled' : 'disabled'}
            />
            <Row label="Upload types" value={capabilities.supported_uploads.join(' ')} />
          </dl>
        ) : null}

        <button type="button" className="btn-ghost mt-4" onClick={() => void refresh()}>
          Refresh
        </button>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">What this tool can and cannot tell you</h2>
        <ul className="mt-3 space-y-2 text-sm text-muted">
          <li>
            <strong className="text-ink">Covert channels are measured, not guessed.</strong> Hidden
            characters and decoded payloads are facts about the bytes of the document.
          </li>
          <li>
            <strong className="text-ink">The style score is a probability about register.</strong>{' '}
            It says how much the writing resembles unedited assistant output — not who wrote it. It
            is unreliable below roughly 150 words, on translated text, and on edited output.
          </li>
          <li>
            <strong className="text-ink">A clean result proves nothing.</strong> Normalising a
            document strips every covert channel this tool can see.
          </li>
          <li>
            <strong className="text-ink">Do not use a score on its own to accuse anyone.</strong>{' '}
            Corroborate with drafts, document history or authorship metadata.
          </li>
        </ul>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/60 py-1">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-mono text-xs">{value}</dd>
    </div>
  );
}
