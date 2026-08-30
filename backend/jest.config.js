module.exports = {
    testEnvironment: 'node',
    // Placeholder provider keys when the environment has none, so the suite runs on a fresh clone.
    setupFiles: ['<rootDir>/tests/helpers/env.defaults.js'],
    testMatch: ['**/tests/**/*.test.js'],
    collectCoverageFrom: ['src/**/*.js', '!**/node_modules/**'],
    coverageDirectory: 'coverage',
    verbose: true,
    testTimeout: 30000,
};
