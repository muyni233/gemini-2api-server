FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY LICENSE ./LICENSE

ENV GEMINI_2API_HOST=0.0.0.0
ENV GEMINI_2API_PORT=8787
ENV NODE_ENV=production

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "require('node:http').get('http://127.0.0.1:' + process.env.GEMINI_2API_PORT + '/healthz', r => { r.resume(); process.exitCode = r.statusCode === 200 ? 0 : 1; }).on('error', () => process.exit(1))"

CMD ["node", "--max-http-header-size=131072", "src/index.js"]
