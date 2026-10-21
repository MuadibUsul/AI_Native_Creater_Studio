# syntax=docker/dockerfile:1.7
#
# ANCS 生产镜像（一个仓库、两个目标）：
#   runtime  —— API / Web / Realtime / 迁移任务（按命令区分进程）
#   worker   —— runtime + FFmpeg（含 flite 本地语音）+ Chromium（Remotion 渲染与特效图层）+ 中日韩字体
#
#   docker build --target runtime -t ancs:runtime .
#   docker build --target worker  -t ancs:worker  .
#
# 构建期需要访问 npm 镜像源；在需要企业根证书的网络里，用 BuildKit secret 传入（只在安装依赖的那几步可见，不写进镜像）：
#   docker build --secret id=extra_ca,src=./corp-ca.pem ...
# 浏览器直连实时语音网关的地址在构建期写进前端（NEXT_PUBLIC_*），见 --build-arg NEXT_PUBLIC_ANCS_REALTIME_URL。

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /app
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS build
# 前端构建期常量：实时语音网关的浏览器地址（空 = 与 Web 同源的 /realtime 路径），API 内网地址（Web 的 /api/v1 转发目标）
ARG NEXT_PUBLIC_ANCS_REALTIME_URL=
ARG ANCS_API_INTERNAL_URL=http://api:3001
ENV NEXT_PUBLIC_ANCS_REALTIME_URL=${NEXT_PUBLIC_ANCS_REALTIME_URL} \
    ANCS_API_INTERNAL_URL=${ANCS_API_INTERNAL_URL}
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile && pnpm build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# 本地存储驱动的数据目录（生产请挂持久卷；多机部署改用对象存储）
RUN mkdir -p /data/storage && chown node:node /data/storage
ENV ANCS_STORAGE_LOCAL_DIR=/data/storage
USER node
EXPOSE 3000 3001 3002
# 缺省进程是 API；Web / Realtime / 迁移在编排里改命令（见 infra/docker-compose.prod.yml）
CMD ["node", "apps/api/dist/index.js"]

FROM runtime AS worker
USER root
# 只能走 HTTPS 出网的构建环境：--build-arg DEBIAN_MIRROR=https://deb.debian.org（企业根证书同样经 extra_ca secret 传入）
ARG DEBIAN_MIRROR=
RUN --mount=type=secret,id=extra_ca,required=false \
    set -e; \
    if [ -n "$DEBIAN_MIRROR" ]; then sed -i "s#http://deb.debian.org#${DEBIAN_MIRROR}#g" /etc/apt/sources.list.d/debian.sources; fi; \
    APT_CA=""; if [ -f /run/secrets/extra_ca ]; then cp /run/secrets/extra_ca /tmp/extra_ca.pem; chmod 644 /tmp/extra_ca.pem; APT_CA="-o Acquire::https::CaInfo=/tmp/extra_ca.pem"; fi; \
    apt-get $APT_CA update; \
    apt-get $APT_CA install -y --no-install-recommends ffmpeg chromium fonts-noto-cjk fonts-noto-color-emoji ca-certificates; \
    rm -rf /var/lib/apt/lists/* /tmp/extra_ca.pem
ENV REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium \
    ANCS_FFMPEG_PATH=/usr/bin/ffmpeg \
    ANCS_FFPROBE_PATH=/usr/bin/ffprobe
USER node
CMD ["node", "apps/worker/dist/main.js"]
