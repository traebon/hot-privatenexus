FROM node:20-alpine
WORKDIR /app
COPY app/backend/package*.json ./
RUN npm ci
COPY app/backend/ ./
# Runtime state directory (drafts, file backups, apply/restore logs, known-good
# markers, backup labels) -- must exist and be writable by the non-root
# container user (compose sets user: "1000", the image's built-in "node"
# user) before any of that code runs, since COPY leaves everything root:root.
RUN mkdir -p /app/data && chown -R node:node /app/data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1
CMD ["npm", "start"]
