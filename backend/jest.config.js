module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    collectCoverageFrom: [
        'controllers/**/*.js',
        'db/**/*.js',
        'routes/**/*.js',
        'middlewares/**/*.js',
        '!**/node_modules/**',
    ],
    coverageDirectory: 'coverage',
    verbose: true,
    testTimeout: 30000,
};
