const request = require('supertest');
const app = require('../src/app');

// Mock sessionManager to avoid DB dependencies during route testing
jest.mock('../src/blueprint/sessionManager', () => ({
    get: jest.fn((id) => {
        if (id === '123') return { id: '123', stage: 0, messages: [], files: {} };
        return null;
    }),
    create: jest.fn(() => ({ id: '123' })),
    addMessage: jest.fn(),
    setLanguage: jest.fn(),
    advanceStage: jest.fn(() => 1),
    TOTAL_STAGES: 18
}));

// Mock ai client to avoid API calls
jest.mock('../src/ai/client', () => ({
    createAIClient: jest.fn(() => ({
        stream: async function* () {
            yield { type: 'text', content: 'hello' };
            yield { type: 'done' };
        }
    }))
}));

describe('Chat API Reproduction', () => {
    it('should PASS (200) when calling /api/chat/:sessionId', async () => {
        const res = await request(app)
            .post('/api/chat/123')
            .send({ message: 'hello' });

        expect(res.status).toBe(200);
    });

    it('should PASS (200) when calling the session creation route', async () => {
        const res = await request(app)
            .post('/api/chat/session');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('sessionId');
    });
});
