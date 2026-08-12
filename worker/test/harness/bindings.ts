/**
 * Test doubles for the Cloudflare bindings.
 *
 * D1 is backed by a real in-memory SQLite database (`node:sqlite`) running the
 * production migration, so the SQL in `lib/db.ts` is genuinely executed rather
 * than matched against a mock. KV and R2 are small in-memory implementations of
 * the parts of their interfaces this Worker uses.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Env } from '../../src/types';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Every migration, in filename order - the same order Wrangler applies them. */
function migrationSql(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf-8'));
}

// `node:sqlite` is not listed in `module.builtinModules`, so Vite's bundler
// treats it as a package on disk and fails to resolve it. Requiring it at
// runtime keeps it out of the static import graph.
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: never[]): unknown;
    all(...params: never[]): unknown[];
    run(...params: never[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  };
  close(): void;
};

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

// --------------------------------------------------------------------------
// D1
// --------------------------------------------------------------------------
class FakeD1PreparedStatement {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.db, this.sql, params);
  }

  private normalized(): unknown[] {
    // node:sqlite accepts null/number/string/bigint/buffer only; booleans and
    // undefined arrive from application code and must be coerced.
    return this.params.map((param) => {
      if (param === undefined) return null;
      if (typeof param === 'boolean') return param ? 1 : 0;
      return param;
    });
  }

  async first<T>(): Promise<T | null> {
    const statement = this.db.prepare(this.sql);
    const row = statement.get(...(this.normalized() as never[]));
    return (row as T) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true }> {
    const statement = this.db.prepare(this.sql);
    return { results: statement.all(...(this.normalized() as never[])) as T[], success: true };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const statement = this.db.prepare(this.sql);
    const info = statement.run(...(this.normalized() as never[]));
    return {
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }
}

export class FakeD1Database {
  private readonly db: SqliteDatabase;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of migrationSql()) {
      this.db.exec(sql);
    }
  }

  prepare(sql: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.db, sql);
  }

  async batch<T = unknown>(statements: FakeD1PreparedStatement[]): Promise<T[]> {
    const results: unknown[] = [];
    this.db.exec('BEGIN');
    try {
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return results as T[];
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  close(): void {
    this.db.close();
  }
}

// --------------------------------------------------------------------------
// KV
// --------------------------------------------------------------------------
interface KvEntry {
  value: string;
  expiresAt: number | null;
}

export class FakeKVNamespace {
  private readonly store = new Map<string, KvEntry>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }> {
    const prefix = options?.prefix ?? '';
    return {
      keys: [...this.store.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
    };
  }

  get size(): number {
    return this.store.size;
  }
}

// --------------------------------------------------------------------------
// R2
// --------------------------------------------------------------------------
interface R2Entry {
  body: ArrayBuffer;
  contentType: string;
  customMetadata: Record<string, string>;
}

function toArrayBuffer(value: string | ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (typeof value === 'string') {
    const encoded = new TextEncoder().encode(value);
    return encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
  }
  return value;
}

export class FakeR2Bucket {
  private readonly store = new Map<string, R2Entry>();

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void> {
    this.store.set(key, {
      body: toArrayBuffer(value),
      contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream',
      customMetadata: options?.customMetadata ?? {},
    });
  }

  async get(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      key,
      httpMetadata: { contentType: entry.contentType },
      customMetadata: entry.customMetadata,
      text: async () => new TextDecoder().decode(entry.body),
      arrayBuffer: async () => entry.body,
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number }) {
    const prefix = options?.prefix ?? '';
    const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
    const limited = options?.limit ? keys.slice(0, options.limit) : keys;
    return {
      objects: limited.map((key) => ({ key, size: this.store.get(key)!.body.byteLength })),
      truncated: limited.length < keys.length,
    };
  }

  get size(): number {
    return this.store.size;
  }
}

// --------------------------------------------------------------------------
// Environment + execution context
// --------------------------------------------------------------------------
export interface TestEnv extends Env {
  DB: D1Database;
  CACHE: KVNamespace;
  BUCKET: R2Bucket;
}

export function createTestEnv(overrides: Partial<Env> = {}): TestEnv {
  return {
    DB: new FakeD1Database() as unknown as D1Database,
    CACHE: new FakeKVNamespace() as unknown as KVNamespace,
    BUCKET: new FakeR2Bucket() as unknown as R2Bucket,
    ANALYSIS_SPACE_URL: 'https://engine.test',
    ANALYSIS_SPACE_TOKEN: 'engine-token',
    SESSION_SECRET: 'test-session-secret-value',
    ALLOWED_ORIGINS: '*',
    RATE_LIMIT_REQUESTS: '1000',
    RATE_LIMIT_WINDOW: '60',
    DAILY_ANALYSIS_LIMIT: '1000',
    MAX_TEXT_CHARS: '200000',
    MAX_UPLOAD_BYTES: '1048576',
    SPACE_TIMEOUT_MS: '5000',
    MAX_ATTEMPTS: '3',
    ENVIRONMENT: 'test',
    ...overrides,
  } as TestEnv;
}

/** Execution context that lets a test await everything `waitUntil` scheduled. */
export class TestExecutionContext {
  readonly pending: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  passThroughOnException(): void {
    /* no-op in tests */
  }

  async settle(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.pending.length);
      await Promise.allSettled(batch);
    }
  }
}
