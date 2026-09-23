import { UpstreamError } from './upstream_stream.js';
import { once } from 'node:events';

/** Serialize writes and propagate downstream backpressure to the upstream reader. */
export function createSseWriter(response, signal, maxPendingBytes = 1024 * 1024) {
    let pendingBytes = 0;
    let queue = Promise.resolve();

    function write(value) {
        const chunk = `data: ${JSON.stringify(value)}\n\n`;
        const size = Buffer.byteLength(chunk);
        pendingBytes += size;
        if (pendingBytes > maxPendingBytes) {
            pendingBytes -= size;
            throw new UpstreamError(
                'Streaming client is too slow or response chunk is too large.',
                { status: 503 }
            );
        }
        queue = queue
            .then(async () => {
                signal.throwIfAborted();
                if (response.destroyed || response.writableEnded)
                    throw new DOMException('Client disconnected', 'AbortError');
                if (response.write(chunk)) return;
                // The request lifecycle aborts signal on disconnect or timeout.
                try {
                    await once(response, 'drain', { signal });
                } catch (error) {
                    throw signal.aborted ? signal.reason : error;
                }
            })
            .finally(() => {
                pendingBytes -= size;
            });
        // Synchronous third-party providers may not await their update callback.
        // flush() still observes failures, without an unhandled rejection meanwhile.
        queue.catch(() => {});
        return queue;
    }
    return { write, flush: () => queue, isIdle: () => pendingBytes === 0 };
}
