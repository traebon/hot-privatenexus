FROM node:20-alpine AS build
WORKDIR /app
COPY app/frontend/package*.json ./
RUN npm install
COPY app/frontend/ ./
ARG VITE_API_BASE=http://localhost:3001
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
