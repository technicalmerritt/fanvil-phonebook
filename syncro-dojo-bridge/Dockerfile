# Builds the bridge into a small container image.
# No npm install is needed: the project has no dependencies.
FROM node:22-alpine

WORKDIR /app

COPY package.json index.js ./
COPY src ./src
COPY public ./public

# Listen on all interfaces inside the container so other computers can reach it.
# Secrets are NOT baked in; they are supplied at runtime (see docker-compose.yml).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    LEDGER_PATH=/data/ledger.jsonl

RUN mkdir -p /data && chown node:node /data
USER node

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "index.js"]
