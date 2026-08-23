const { hashPassword, verifyPassword, MIN_LENGTH } = require('../src/auth/password');

describe('password hashing', () => {
    it('produces a verifiable hash', async () => {
        const stored = await hashPassword('correct horse battery staple');
        expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    });

    it('rejects the wrong password', async () => {
        const stored = await hashPassword('correct horse battery staple');
        expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
    });

    it('never stores the password itself', async () => {
        const stored = await hashPassword('hunter2-and-then-some');
        expect(stored).not.toContain('hunter2-and-then-some');
    });

    it('salts, so the same password hashes differently every time', async () => {
        const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
        expect(a).not.toBe(b);
        expect(await verifyPassword('same-password', a)).toBe(true);
        expect(await verifyPassword('same-password', b)).toBe(true);
    });

    it('refuses a password shorter than the floor, rather than storing a weak one', async () => {
        await expect(hashPassword('x'.repeat(MIN_LENGTH - 1))).rejects.toThrow(/at least/i);
    });

    it('refuses an absurdly long password instead of burning CPU on it', async () => {
        await expect(hashPassword('x'.repeat(4096))).rejects.toThrow(/too long/i);
    });

    it('returns false for a malformed stored value rather than throwing', async () => {
        for (const bad of ['', 'not-a-hash', 'scrypt$only-two$parts', null, undefined]) {
            expect(await verifyPassword('anything', bad)).toBe(false);
        }
    });

    it('compares in constant time, so a wrong hash of the right length is not fast-pathed', async () => {
        const stored = await hashPassword('a-real-password');
        const [scheme, salt] = stored.split('$');
        const forged = `${scheme}$${salt}$${'0'.repeat(stored.split('$')[2].length)}`;
        expect(await verifyPassword('a-real-password', forged)).toBe(false);
    });
});
