import { startGemini2ApiServer } from './gemini_2api.js';

const { host, port, server } = await startGemini2ApiServer();

console.log(`Gemini 2API listening on http://${host}:${port}`);
console.log(
    'Authentication is disabled; keep the listener on localhost or put it behind your own access control.'
);

function shutdown(signal) {
    console.log(`Received ${signal}; stopping Gemini 2API.`);
    server.close((error) => {
        if (error) {
            console.error(error);
            process.exitCode = 1;
        }
    });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
