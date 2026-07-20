// tests/queue.test.js
// AMQP publisher connection pooling and message routing tests.
// Verifies single connection sharing, reconnect logic, and publish semantics.

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('amqplib');

jest.mock('../src/core/config', () => ({
    queues: {
        CLOUDAMQP_URL: 'amqp://test:test@localhost:5672',
    },
}));

const amqp = require('amqplib');
const { getChannel, publishToQueue, closeAmqp, _resetForTests } = require('../src/infra/queue');

describe('queue (AMQP publisher)', () => {
    beforeEach(() => {
        _resetForTests();
        jest.clearAllMocks();
    });

    afterEach(async () => {
        await closeAmqp();
        _resetForTests();
    });

    it('concurrent getChannel() calls share one connection', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        const promises = [
            getChannel(),
            getChannel(),
            getChannel(),
            getChannel(),
            getChannel(),
        ];

        await Promise.all(promises);

        expect(amqp.connect).toHaveBeenCalledTimes(1);
        expect(amqp.connect).toHaveBeenCalledWith('amqp://test:test@localhost:5672');
    });

    it('failed connect does not poison the cached promise', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        // First call fails
        amqp.connect.mockRejectedValueOnce(new Error('connection refused'));

        const firstCall = getChannel();
        await expect(firstCall).rejects.toThrow('connection refused');

        // Second call succeeds
        amqp.connect.mockResolvedValueOnce(mockConnection);
        const secondCall = getChannel();
        await expect(secondCall).resolves.toBe(mockChannel);

        // Verify connect was called twice (once failed, once succeeded)
        expect(amqp.connect).toHaveBeenCalledTimes(2);
    });

    it('publishToQueue asserts queue as durable', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn().mockReturnValue(true),
            waitForConfirms: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        await publishToQueue('test_queue', { id: 1, name: 'test' });

        expect(mockChannel.assertQueue).toHaveBeenCalledWith('test_queue', { durable: true });
    });

    it('publishToQueue sends JSON buffer that round-trips to original object', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn().mockReturnValue(true),
            waitForConfirms: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        const originalObject = { id: 1, name: 'test', nested: { value: 123 } };
        await publishToQueue('test_queue', originalObject);

        const sendToQueueCall = mockChannel.sendToQueue.mock.calls[0];
        const buffer = sendToQueueCall[1];
        const parsedObject = JSON.parse(buffer.toString());

        expect(parsedObject).toEqual(originalObject);
    });

    it('publishToQueue marks message persistent', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn().mockReturnValue(true),
            waitForConfirms: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        await publishToQueue('test_queue', { id: 1 });

        const sendToQueueCall = mockChannel.sendToQueue.mock.calls[0];
        const options = sendToQueueCall[2];

        expect(options.persistent).toBe(true);
    });

    it('publishToQueue allows opts to override default options', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn().mockReturnValue(true),
            waitForConfirms: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        await publishToQueue('test_queue', { id: 1 }, { persistent: false, priority: 5 });

        const sendToQueueCall = mockChannel.sendToQueue.mock.calls[0];
        const options = sendToQueueCall[2];

        expect(options.persistent).toBe(false);
        expect(options.priority).toBe(5);
    });

    it('closeAmqp safely closes channel and connection', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        await getChannel();
        await closeAmqp();

        expect(mockChannel.close).toHaveBeenCalled();
        expect(mockConnection.close).toHaveBeenCalled();
    });

    it('closeAmqp is safe to call twice', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        await getChannel();
        await closeAmqp();
        await closeAmqp();

        expect(mockChannel.close).toHaveBeenCalledTimes(1);
        expect(mockConnection.close).toHaveBeenCalledTimes(1);
    });

    it('closeAmqp is safe when nothing was ever connected', async () => {
        await closeAmqp();
        await closeAmqp();

        expect(amqp.connect).not.toHaveBeenCalled();
    });

    it('closeAmqp handles channel close exceptions gracefully', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockRejectedValue(new Error('channel already closed')),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        await getChannel();
        await expect(closeAmqp()).resolves.toBeUndefined();
        expect(mockConnection.close).toHaveBeenCalled();
    });

    it('closeAmqp handles connection close exceptions gracefully', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockRejectedValue(new Error('connection already closed')),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        await getChannel();
        await expect(closeAmqp()).resolves.toBeUndefined();
    });

    it('publishToQueue propagates channel assertQueue errors', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
            assertQueue: jest.fn().mockRejectedValue(new Error('queue assertion failed')),
            sendToQueue: jest.fn().mockReturnValue(true),
            waitForConfirms: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        await expect(publishToQueue('test_queue', { id: 1 })).rejects.toThrow('queue assertion failed');
    });

    it('publishToQueue propagates waitForConfirms errors', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn().mockReturnValue(true),
            waitForConfirms: jest.fn().mockRejectedValue(new Error('broker nack')),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        await expect(publishToQueue('test_queue', { id: 1 })).rejects.toThrow('broker nack');
    });

    it('publishToQueue waits for broker confirmation', async () => {
        const mockChannel = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn().mockReturnValue(true),
            waitForConfirms: jest.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        };

        amqp.connect.mockResolvedValue(mockConnection);

        await publishToQueue('test_queue', { id: 1 });

        expect(mockChannel.waitForConfirms).toHaveBeenCalled();
    });
});
