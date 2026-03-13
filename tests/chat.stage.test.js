const request = require('supertest');
const app = require('../src/app');
const sessionManager = require('../src/blueprint/sessionManager.v2');

// Mock sessionManager
jest.mock('../src/blueprint/sessionManager.v2', () => ({
    get: jest.fn((id) => {
        return { id, stage: 0, messages: [], files: {}, language: 'English' };
    }),
    create: jest.fn(() => ({ id: '123' })),
    addMessage: jest.fn(),
    setLanguage: jest.fn(),
    addFile: jest.fn(),
    advanceStage: jest.fn((id) => 1), // Advance from 0 to 1
    TOTAL_STAGES: 18
}));

// Mock ai client to simulate a tool call
jest.mock('../src/ai/client', () => ({
    createAIClient: jest.fn(() => ({
        stream: async function* () {
            yield { type: 'text', content: 'Thinking...' };
            yield {
                type: 'tool_call',
                name: 'complete_stage',
                input: {}
            };
            yield { type: 'done' };
        }
    }))
}));

describe('Chat Stage Advance TDD', () => {
    it('should send stage_complete event with correct nextStage when AI advances', async () => {
        const res = await request(app)
            .post('/api/chat/123')
            .send({ message: 'next' });

        expect(res.status).toBe(200);

        // Check SSE response content
        const body = res.text;
        expect(body).toContain('"type":"stage_complete"');
        expect(body).toContain('"completedStage":0');
        expect(body).toContain('"nextStage":1');
    });
});
