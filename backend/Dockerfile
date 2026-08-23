# Backend API and summary worker. One image, two entrypoints: `npm start` serves HTTP,
# `npm run worker:summary` drains the summary queue. Which one a container runs is the
# deployment's choice, not the image's.

FROM node:22-slim AS deps
WORKDIR /app
# ffmpeg-installer and ffprobe-installer download a platform binary on install, so this layer
# has to be built for the architecture it will run on. Do not copy node_modules from a host.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app

# Runs unprivileged. The image holds no keys; everything secret arrives as an environment
# variable at start, which is why there is no .env here and .dockerignore excludes it.
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# src reaches outside itself for these: chat.controller and the summary service require
# ../../prompts by relative path, so an image with only src/ starts and dies on the first require.
COPY prompts ./prompts
USER node

EXPOSE 3000

# The platform's own health check should hit this too; it is the one route that needs no auth.
# Reads PORT rather than assuming 3000: a deployment that sets one would otherwise be reported
# unhealthy while serving correctly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
