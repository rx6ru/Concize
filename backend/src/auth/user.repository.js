// Accounts, for deployments that issue their own tokens.

'use strict';

const crypto = require('crypto');
const { query } = require('../infra/postgres');

/** @returns {Promise<{id: string, email: string}>} */
async function createUser(email, passwordHash) {
    // Generated here rather than by the database, matching how chats.id is made: the DB test
    // double has no gen_random_uuid().
    const { rows } = await query(
        `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)
         RETURNING id, email`,
        [crypto.randomUUID(), email, passwordHash]
    );
    return rows[0];
}

/** @returns {Promise<?{id: string, email: string, passwordHash: string}>} */
async function findUserByEmail(email) {
    const { rows } = await query(
        'SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)',
        [email]
    );
    if (!rows.length) return null;
    return { id: rows[0].id, email: rows[0].email, passwordHash: rows[0].password_hash };
}

module.exports = { createUser, findUserByEmail };
