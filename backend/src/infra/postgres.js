//
// Single Postgres access point (node-postgres Pool) for Supabase Postgres.
//
// Connection guidance (grounded in Supabase docs, 2026): use the DIRECT connection or the
// SESSION-mode pooler — both on port 5432 — for this backend, because it runs explicit
// transactions / SELECT ... FOR UPDATE. Do NOT use the transaction-mode pooler (port 6543):
// it recycles connections between statements and is unsafe for session/row-locking workloads.

const { Pool } = require('pg');
const config = require('../core/config');
const { createLogger } = require('../core/logger');

const logger = createLogger('pg');

let pool = null;

/**
 * Returns the shared connection pool, constructing it on first use.
 * @returns {import('pg').Pool}
 */
function getPool() {
    if (pool) return pool;

    const connectionString = config.database.POSTGRES_URL;
    if (!connectionString) {
        throw new Error('POSTGRES_URL is not configured');
    }

    pool = new Pool({
        connectionString,
        // Supabase requires TLS; allow opting out only for local/dev via PGSSL=disable.
        ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
        max: Number(process.env.PG_POOL_MAX || 10),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
    });

    pool.on('error', (err) => logger.error('Idle Postgres client error', { error: err.message }));
    return pool;
}

/**
 * Runs a single parameterized query against the pool.
 * @param {string} text SQL with $1, $2 placeholders.
 * @param {Array} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
function query(text, params) {
    return getPool().query(text, params);
}

/**
 * Runs `fn` inside a transaction on a dedicated client (BEGIN/COMMIT/ROLLBACK).
 * Use for read-modify-write paths that need SELECT ... FOR UPDATE.
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function withTransaction(fn) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** Verifies connectivity at startup (replaces the old Mongo connect step). */
async function connectPg() {
    await query('SELECT 1');
    logger.info('Connected to Postgres');
}

/** Closes the pool (graceful shutdown / tests). */
async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

/** Test seam: inject a pg-mem (or other) Pool so the real SQL runs against an in-memory db. */
function _setPoolForTesting(testPool) {
    pool = testPool;
}

module.exports = { getPool, query, withTransaction, connectPg, closePool, _setPoolForTesting };
