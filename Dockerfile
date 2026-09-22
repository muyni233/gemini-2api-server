FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV GEMINI_2API_HOST=0.0.0.0
ENV GEMINI_2API_PORT=8787

EXPOSE 8787

CMD ["node", "--max-http-header-size=131072", "src/index.js"]
