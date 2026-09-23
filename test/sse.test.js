import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { it } from 'node:test';
import { createSseWriter } from '../src/sse.js';

it('serializes SSE writes and stops waiting on a slow socket when cancelled', async () => {
    const releases = [];
    const received = [];
    const response = new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
            received.push(chunk.toString());
            releases.push(callback);
        },
    });
    const controller = new AbortController();
    const writer = createSseWriter(response, controller.signal);
    const first = writer.write({ text: 'first' });
    const second = writer.write({ text: 'second' });
    await setImmediate();
    assert.equal(received.length, 1);
    releases.shift()();
    await first;
    await setImmediate();
    assert.equal(received.length, 2);
    controller.abort();
    await assert.rejects(second, { name: 'AbortError' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(response.listenerCount('drain'), 0);
    releases.shift()();
    response.destroy();
});

it('bounds queued SSE bytes even when a provider ignores callback backpressure', async () => {
    const response = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
    const writer = createSseWriter(response, new AbortController().signal, 64);
    writer.write({ text: 'a'.repeat(20) });
    assert.throws(() => writer.write({ text: 'b'.repeat(20) }), /too slow/);
    await writer.flush();
    response.destroy();
});
