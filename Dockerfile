FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    KKTC_DB_PATH=/app/data/kktc.db
COPY --from=build /app/apps/node/dist/server.js ./server.js
COPY data/kktc.db ./data/kktc.db
EXPOSE 8080
CMD ["node", "server.js"]
