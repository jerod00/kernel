FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js db.js synopsis.js ./

# kernel.db lives on a mounted Fly volume (see fly.toml), not in the image —
# DB_PATH is set via [env] in fly.toml to point inside that mount, so the
# append-only log survives deploys and restarts instead of resetting empty.
EXPOSE 3002

CMD ["node", "--experimental-sqlite", "server.js"]
