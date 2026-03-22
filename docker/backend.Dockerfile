FROM node:20-alpine
WORKDIR /app
COPY app/backend/package*.json ./
RUN npm install
COPY app/backend/ ./
EXPOSE 3001
CMD ["npm", "start"]
