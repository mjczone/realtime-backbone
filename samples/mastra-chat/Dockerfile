# Sample only.
FROM node:24-alpine
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY ts/contract/package.json ts/contract/
COPY ts/publisher/package.json ts/publisher/
COPY ts/tokens/package.json ts/tokens/
COPY ts/client/package.json ts/client/
COPY ts/agui-client/package.json ts/agui-client/
COPY ts/mastra/package.json ts/mastra/
COPY samples/chat-web/package.json samples/chat-web/
COPY samples/mastra-chat/package.json samples/mastra-chat/
RUN pnpm install --frozen-lockfile --filter @rtb-samples/mastra-chat...
COPY ts ts
COPY samples/chat-web samples/chat-web
COPY samples/mastra-chat samples/mastra-chat
RUN pnpm --filter @rtb-samples/mastra-chat^... build
WORKDIR /repo/samples/mastra-chat
EXPOSE 3001
CMD ["node", "src/server.ts"]
