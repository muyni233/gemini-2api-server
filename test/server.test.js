import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createGemini2ApiServer } from '../src/gemini_2api.js';

let server;
let baseUrl;
let sendMessage;

async function startServer() {
    server = createGemini2ApiServer({ sendMessage });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
}

beforeEach(async () => {
    sendMessage = async () => ({ text: 'Hello from anonymous Gemini.' });
    await startServer();
});

afterEach(stopServer);

describe('Gemini 2API server', () => {
    it('lists models without authentication', async () => {
        const response = await fetch(`${baseUrl}/v1beta/models`);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
        assert.ok(body.models.some((model) => model.name === 'models/gemini-3.8-flash'));
    });

    it('returns a native Gemini generateContent response', async () => {
        let capturedPrompt = '';
        sendMessage = async (prompt) => {
            capturedPrompt = prompt;
            return { text: 'Hello from anonymous Gemini.' };
        };
        await stopServer();
        await startServer();

        const response = await fetch(`${baseUrl}/v1beta/models/gemini-3.8-flash:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: 'Be concise.' }] },
                contents: [{ role: 'user', parts: [{ text: 'Say hello.' }] }],
            }),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(body.candidates[0].content, {
            role: 'model',
            parts: [{ text: 'Hello from anonymous Gemini.' }],
        });
        assert.match(capturedPrompt, /System instruction:\nBe concise\./);
    });

    it('bridges tool declarations into a Gemini functionCall part', async () => {
        sendMessage = async () => ({
            text: '<function_call>{"name":"get_weather","args":{"city":"Shanghai"}}</function_call>',
        });
        await stopServer();
        await startServer();

        const response = await fetch(`${baseUrl}/v1beta/models/gemini-3.8-flash:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'What is the weather?' }] }],
                tools: [
                    {
                        functionDeclarations: [
                            { name: 'get_weather', parameters: { type: 'object' } },
                        ],
                    },
                ],
                toolConfig: { functionCallingConfig: { mode: 'ANY' } },
            }),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(body.candidates[0].content.parts, [
            { functionCall: { name: 'get_weather', args: { city: 'Shanghai' } } },
        ]);
    });

    it('streams Gemini SSE without an OpenAI DONE sentinel', async () => {
        sendMessage = async (prompt, model, files, signal, onUpdate) => {
            onUpdate('Hello');
            onUpdate('Hello world');
            return { text: 'Hello world' };
        };
        await stopServer();
        await startServer();

        const response = await fetch(
            `${baseUrl}/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: 'Say hello.' }] }],
                }),
            }
        );
        const text = await response.text();
        const events = text
            .split('\n\n')
            .filter((block) => block.startsWith('data: '))
            .map((block) => JSON.parse(block.slice('data: '.length)));

        assert.equal(response.status, 200);
        assert.equal(events[0].candidates[0].content.parts[0].text, 'Hello');
        assert.equal(events[1].candidates[0].content.parts[0].text, ' world');
        assert.equal(events.at(-1).candidates[0].finishReason, 'STOP');
        assert.ok(!text.includes('data: [DONE]'));
    });
});
