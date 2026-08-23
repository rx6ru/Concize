// Password hashing, using Node's own scrypt rather than a dependency.
//
// scrypt is memory-hard, which is what makes a stolen hash expensive to attack in bulk. The cost
// parameters below are the Node defaults raised to a level that takes tens of milliseconds here,
// which is slow enough to matter to an attacker and fast enough for a login.
//
// Stored form is `scrypt$<salt-hex>$<hash-hex>`, self-describing so the parameters can change
// later without a migration guessing which scheme produced an old row.

'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SCHEME = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const COST = 2 ** 15;          // N, the memory/CPU factor
const BLOCK_SIZE = 8;          // r
const PARALLELISM = 1;         // p

const MIN_LENGTH = 8;
// scrypt cost is paid on the server, so an attacker must not choose how much of it we spend.
const MAX_LENGTH = 1024;

// A structurally valid stored hash that verifies against no real password.
// Lets a failed lookup (unknown email) pay the same scrypt cost as a failed password check, so
// the two are not distinguishable by response time. See auth.routes.js login.
const DUMMY_HASH = `${SCHEME}$${'00'.repeat(SALT_BYTES)}$${'00'.repeat(KEY_BYTES)}`;

async function derive(password, salt) {
    return scrypt(password, salt, KEY_BYTES, { N: COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: 128 * COST * BLOCK_SIZE * 2 });
}

/** @returns {Promise<string>} the stored form, never the password */
async function hashPassword(password) {
    if (typeof password !== 'string' || password.length < MIN_LENGTH) {
        throw new Error(`Password must be at least ${MIN_LENGTH} characters`);
    }
    if (password.length > MAX_LENGTH) {
        throw new Error('Password is too long');
    }
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = await derive(password, salt);
    return `${SCHEME}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Never throws on a malformed stored value: a corrupt row is a failed login, not a 500. */
async function verifyPassword(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;

    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== SCHEME) return false;

    const [, saltHex, hashHex] = parts;
    let salt;
    let expected;
    try {
        salt = Buffer.from(saltHex, 'hex');
        expected = Buffer.from(hashHex, 'hex');
    } catch {
        return false;
    }
    if (!salt.length || expected.length !== KEY_BYTES) return false;
    if (password.length > MAX_LENGTH) return false;

    const actual = await derive(password, salt);
    return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword, MIN_LENGTH, MAX_LENGTH, DUMMY_HASH };
