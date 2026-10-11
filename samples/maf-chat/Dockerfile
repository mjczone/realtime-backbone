# Sample only. Build context is the repo root.
FROM node:24-alpine AS web
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY ts/contract/package.json ts/contract/
COPY ts/client/package.json ts/client/
COPY ts/agui-client/package.json ts/agui-client/
COPY samples/chat-web/package.json samples/chat-web/
RUN pnpm install --frozen-lockfile --filter @realtime-samples/chat-web...
COPY ts/contract ts/contract
COPY ts/client ts/client
COPY ts/agui-client ts/agui-client
COPY samples/chat-web samples/chat-web
RUN pnpm --filter @realtime-samples/chat-web... build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /repo
COPY proto proto
COPY dotnet dotnet
COPY samples/maf-chat samples/maf-chat
RUN dotnet publish samples/maf-chat/MafChat.csproj -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
COPY --from=build /out .
COPY --from=web /repo/samples/chat-web/public /web
ENV RTB_WEB_DIR=/web
EXPOSE 3002
ENTRYPOINT ["dotnet", "MafChat.dll"]
