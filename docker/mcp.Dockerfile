FROM node:20-alpine
WORKDIR /app
COPY mcp/package*.json ./
RUN npm ci --omit=dev
COPY mcp/server.js ./
CMD ["node", "server.js"]
