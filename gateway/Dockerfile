FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY shared/package.json shared/package.json
COPY gateway/package.json gateway/package.json
COPY app/package.json app/package.json

RUN npm ci --workspaces --include-workspace-root

COPY shared shared
COPY gateway gateway
COPY app app

RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV BOTTAP_HOST=0.0.0.0
ENV BOTTAP_PORT=8788
ENV BOTTAP_DATA_DIR=/data
ENV BOTTAP_STATIC_DIR=/app/app/dist

COPY package.json package-lock.json* ./
COPY shared/package.json shared/package.json
COPY gateway/package.json gateway/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/gateway/dist gateway/dist
COPY --from=build /app/app/dist app/dist

RUN npm ci --omit=dev --workspace=shared --workspace=gateway && mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 8788
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "gateway/dist/index.js"]
