# Sample only. Build context is the repo root.
FROM node:24-alpine AS web
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY ts/contract/package.json ts/contract/
COPY ts/client/package.json ts/client/
COPY ts/agui-client/package.json ts/agui-client/
COPY samples/mastra-dotnet/web/package.json samples/mastra-dotnet/web/
RUN pnpm install --frozen-lockfile --filter @realtime-samples/mdn-web...
COPY ts/contract ts/contract
COPY ts/client ts/client
COPY ts/agui-client ts/agui-client
COPY samples/mastra-dotnet/web samples/mastra-dotnet/web
RUN pnpm --filter @realtime-samples/mdn-web... build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /repo
COPY proto proto
COPY dotnet dotnet
COPY samples/mastra-dotnet/api samples/mastra-dotnet/api
RUN dotnet publish samples/mastra-dotnet/api/MdnApi.csproj -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
COPY --from=build /out .
COPY --from=web /repo/samples/mastra-dotnet/web/public /web
ENV RTB_WEB_DIR=/web
EXPOSE 3010
ENTRYPOINT ["dotnet", "MdnApi.dll"]
