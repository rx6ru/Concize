// tests/tempAuthCheck.test.js

const tempAuthCheck = require('../middlewares/tempAuthCheck');

// Mock config
jest.mock('../utils/config', () => ({
    ALLOWED_AUTH_CODES: ['valid-code-1', 'valid-code-2', 'test-secret-xyz'],
}));

describe('tempAuthCheck Middleware', () => {
    let mockReq;
    let mockRes;
    let nextFunction;

    beforeEach(() => {
        // Setup mock request, response, and next function
        mockReq = {
            headers: {},
        };
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
        nextFunction = jest.fn();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('Happy Path - Valid Authentication', () => {
        it('should call next() when valid auth code is provided in headers', () => {
            mockReq.headers['x-auth-code'] = 'valid-code-1';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(nextFunction).toHaveBeenCalledTimes(1);
            expect(mockRes.status).not.toHaveBeenCalled();
            expect(mockRes.json).not.toHaveBeenCalled();
        });

        it('should call next() for second valid auth code', () => {
            mockReq.headers['x-auth-code'] = 'valid-code-2';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(nextFunction).toHaveBeenCalledTimes(1);
            expect(mockRes.status).not.toHaveBeenCalled();
        });

        it('should call next() for third valid auth code', () => {
            mockReq.headers['x-auth-code'] = 'test-secret-xyz';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(nextFunction).toHaveBeenCalledTimes(1);
            expect(mockRes.status).not.toHaveBeenCalled();
        });
    });

    describe('Error Cases - Missing Authentication', () => {
        it('should return 401 when x-auth-code header is missing', () => {
            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'Unauthorized: No authentication code provided.',
            });
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should return 401 when x-auth-code header is undefined', () => {
            mockReq.headers['x-auth-code'] = undefined;

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'Unauthorized: No authentication code provided.',
            });
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should return 401 when x-auth-code header is null', () => {
            mockReq.headers['x-auth-code'] = null;

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should return 401 when x-auth-code header is empty string', () => {
            mockReq.headers['x-auth-code'] = '';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });
    });

    describe('Error Cases - Invalid Authentication', () => {
        it('should return 401 when auth code does not match allowed codes', () => {
            mockReq.headers['x-auth-code'] = 'invalid-code';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'Unauthorized: Invalid authentication code.',
            });
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should return 401 for similar but incorrect auth code', () => {
            mockReq.headers['x-auth-code'] = 'valid-code-1-extra';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should return 401 for auth code with wrong case', () => {
            mockReq.headers['x-auth-code'] = 'VALID-CODE-1';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should return 401 for auth code with extra whitespace', () => {
            mockReq.headers['x-auth-code'] = ' valid-code-1 ';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should return 401 for numeric auth code', () => {
            mockReq.headers['x-auth-code'] = '12345';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should return 401 for SQL injection attempt', () => {
            mockReq.headers['x-auth-code'] = "' OR '1'='1";

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should return 401 for special character auth code', () => {
            mockReq.headers['x-auth-code'] = '@#$%^&*()';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });
    });

    describe('Edge Cases', () => {
        it('should handle boolean false as invalid auth code', () => {
            mockReq.headers['x-auth-code'] = false;

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should handle number 0 as invalid auth code', () => {
            mockReq.headers['x-auth-code'] = 0;

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should handle object as invalid auth code', () => {
            mockReq.headers['x-auth-code'] = { code: 'valid-code-1' };

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should handle array as invalid auth code', () => {
            mockReq.headers['x-auth-code'] = ['valid-code-1'];

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });

        it('should be case-sensitive for auth codes', () => {
            mockReq.headers['x-auth-code'] = 'Valid-Code-1';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(nextFunction).not.toHaveBeenCalled();
        });
    });

    describe('Response Structure', () => {
        it('should return proper JSON error structure for missing code', () => {
            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: expect.any(String),
                })
            );
        });

        it('should return proper JSON error structure for invalid code', () => {
            mockReq.headers['x-auth-code'] = 'wrong-code';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: expect.any(String),
                })
            );
        });

        it('should chain status and json calls correctly', () => {
            mockReq.headers['x-auth-code'] = 'invalid';

            tempAuthCheck(mockReq, mockRes, nextFunction);

            expect(mockRes.status).toHaveReturnedWith(mockRes);
            expect(mockRes.json).toHaveBeenCalled();
        });
    });
});