# ---- web build ----
FROM node:22-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- api build ----
FROM node:22-alpine AS api-build
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci
COPY api/ ./
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
COPY api/package*.json ./api/
RUN cd api && npm ci --omit=dev
COPY --from=api-build /app/api/dist ./api/dist
COPY api/data ./api/data
COPY api/config ./api/config
COPY --from=web-build /app/web/dist ./web/dist
WORKDIR /app/api
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
EXPOSE 3001
CMD ["node", "dist/server.js"]
