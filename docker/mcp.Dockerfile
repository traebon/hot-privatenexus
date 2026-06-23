FROM node:20-alpine
WORKDIR /app
COPY mcp/package.json ./
RUN npm install --omit=dev
COPY mcp/server.js ./
CMD ["node", "server.js"]
