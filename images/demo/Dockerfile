FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY ts/contract/package.json ts/contract/
COPY ts/publisher/package.json ts/publisher/
COPY ts/tokens/package.json ts/tokens/
COPY ts/client/package.json ts/client/
COPY images/demo/package.json images/demo/
RUN pnpm install --frozen-lockfile --filter @mjczone/realtime-demo...
COPY ts/contract ts/contract
COPY ts/publisher ts/publisher
COPY ts/tokens ts/tokens
COPY ts/client ts/client
COPY images/demo images/demo
RUN pnpm --filter @mjczone/realtime-demo... build

# Dev only. Runs as root so it can write its signing key to a bind-mounted .data/keys.
FROM node:24-alpine
WORKDIR /app
COPY --from=build /repo/images/demo/dist dist
COPY --from=build /repo/images/demo/public public
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/server.js"]
