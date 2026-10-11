# Sample only. Build context is the repo root.
FROM node:24-alpine
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY ts/contract/package.json ts/contract/
COPY ts/publisher/package.json ts/publisher/
COPY ts/tokens/package.json ts/tokens/
COPY ts/agui-server/package.json ts/agui-server/
COPY samples/mastra-dotnet/agent/package.json samples/mastra-dotnet/agent/
RUN pnpm install --frozen-lockfile --filter @realtime-samples/mdn-agent...
COPY ts ts
COPY samples/mastra-dotnet/agent samples/mastra-dotnet/agent
RUN pnpm --filter @realtime-samples/mdn-agent^... build
WORKDIR /repo/samples/mastra-dotnet/agent
EXPOSE 3011
CMD ["node", "src/server.ts"]
