FROM node:20-alpine
WORKDIR /app
COPY app/backend/package*.json ./
RUN npm ci
COPY app/backend/ ./
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1
CMD ["npm", "start"]
