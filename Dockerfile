# One image for all services; docker-compose picks the entrypoint per service.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY task1-mcp-server/package.json task1-mcp-server/
COPY task2-mcp-gateway/package.json task2-mcp-gateway/
COPY task3-stream-guardrail/package.json task3-stream-guardrail/
COPY task4-model-router/package.json task4-model-router/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY task1-mcp-server task1-mcp-server
COPY task2-mcp-gateway task2-mcp-gateway
COPY task3-stream-guardrail task3-stream-guardrail
COPY task4-model-router task4-model-router
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache curl && adduser -D -u 10001 app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/task1-mcp-server/package.json task1-mcp-server/
COPY --from=build /app/task2-mcp-gateway/package.json task2-mcp-gateway/
COPY --from=build /app/task3-stream-guardrail/package.json task3-stream-guardrail/
COPY --from=build /app/task4-model-router/package.json task4-model-router/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/task1-mcp-server/dist task1-mcp-server/dist
COPY --from=build /app/task1-mcp-server/fixtures task1-mcp-server/fixtures
COPY --from=build /app/task2-mcp-gateway/dist task2-mcp-gateway/dist
COPY --from=build /app/task3-stream-guardrail/dist task3-stream-guardrail/dist
COPY --from=build /app/task4-model-router/dist task4-model-router/dist
RUN mkdir -p /data && chown app:app /data
USER app
# Default: the Task 1 stdio server. Compose overrides `command` per service.
CMD ["node", "task1-mcp-server/dist/server.js"]
