# ---- 构建阶段 ----
FROM node:22-slim AS build
# better-sqlite3 是原生模块：预编译二进制不可用时会回退源码编译，
# 需要 python3/make/g++（node:22-slim 默认不含）
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# 剔除 devDependencies，只保留运行时依赖（better-sqlite3 已在上面编译好）
RUN npm prune --omit=dev

# ---- 运行阶段 ----
FROM node:22-slim
# 时区：展示层（Node Date）按东八区输出
ENV TZ=Asia/Shanghai
WORKDIR /app
ENV NODE_ENV=production
# 直接复用构建阶段的产物，运行阶段不再 npm ci / 编译（镜像保持精简）
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# 运行时数据目录（可由 volume 挂载）
RUN mkdir -p /app/data /app/cache
EXPOSE 18080
CMD ["node", "dist/index.js"]
