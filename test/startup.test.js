import assert from 'node:assert/strict';
import { it } from 'node:test';
import { startGemini2ApiServer } from '../src/gemini_2api.js';

it('rejects invalid ports before listening', async () => {
    for (const port of ['', '1e3', '1.5', ' 8787 ', false, -1, 65536, NaN]) {
        await assert.rejects(startGemini2ApiServer({ port }), /Invalid port/);
    }
});

it('starts on an ephemeral port and reports the actual address', async () => {
    const started = await startGemini2ApiServer({
        host: '127.0.0.1',
        port: 0,
        apiKey: '',
        allowedOrigins: [],
    });
    try {
        assert.ok(started.port > 0);
        const response = await fetch(`http://${started.host}:${started.port}/healthz`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).auth, 'none');
        await assert.rejects(startGemini2ApiServer({ host: started.host, port: started.port }), {
            code: 'EADDRINUSE',
        });
    } finally {
        await started.server.shutdown();
    }
});
