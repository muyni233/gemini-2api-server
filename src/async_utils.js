/** A deadline whose timer and parent listener can be released after success. */
export function createDeadline(parent, timeoutMs, reason) {
    const controller = new AbortController();
    const abort = () => controller.abort(parent.reason);
    const timer = setTimeout(() => controller.abort(reason), timeoutMs);
    timer.unref?.();
    if (parent?.aborted) abort();
    else parent?.addEventListener('abort', abort, { once: true });
    return {
        signal: controller.signal,
        abort: (error) => controller.abort(error),
        dispose() {
            clearTimeout(timer);
            parent?.removeEventListener('abort', abort);
        },
    };
}

/** Cancel one waiter without cancelling a shared operation (e.g. BL refresh). */
export function withAbort(promise, signal) {
    if (!signal) return Promise.resolve(promise);
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise)
            .then(resolve, reject)
            .finally(() => {
                signal.removeEventListener('abort', abort);
            });
    });
}

export function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
        throw new TypeError(`${name} must be a positive integer no larger than 2147483647.`);
    }
    return value;
}
