# ---- 构建阶段 ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# 运行时数据目录（可由 volume 挂载）
RUN mkdir -p /app/data /app/cache
EXPOSE 18080
CMD ["node", "dist/index.js"]
