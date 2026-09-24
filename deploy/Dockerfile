FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --ignore-scripts
COPY server server
COPY web web
RUN npm run build:server && npm run build:web && npm prune --omit=dev --ignore-scripts
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production MY12306_HOST=0.0.0.0 MY12306_DATA_DIR=/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright TZ=Asia/Shanghai
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
RUN node node_modules/playwright/cli.js install --with-deps --only-shell chromium && mkdir /data && chown node:node /data && chmod -R a+rX /ms-playwright
USER node
EXPOSE 7788
CMD ["node", "server/dist/index.js"]
