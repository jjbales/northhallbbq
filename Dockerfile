FROM node:22-slim

# better-sqlite3 needs a toolchain to build its native bits
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Orders live here. Mount a persistent volume at this path or you WILL lose them.
ENV DATA_DIR=/data
ENV PORT=4000
EXPOSE 4000
CMD ["node", "server.js"]
