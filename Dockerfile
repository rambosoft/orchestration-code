FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.json project.example.json uiux.global.json ./
COPY src ./src
COPY projects ./projects
RUN npm ci && npm run build && npm prune --omit=dev
EXPOSE 3101
CMD ["node", "dist/src/server.js"]
