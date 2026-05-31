# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app

# OpenSSL is needed by Prisma's engine
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

# ---- run stage ----
FROM node:20-slim AS run
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma

EXPOSE 4000
# Apply any pending migrations on boot, then start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
