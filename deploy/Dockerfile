# Stage 1: Build (includes devDependencies for TypeScript compilation)
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . ./
RUN npm run build

# Stage 2: Production (only runtime dependencies)
FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build ./build
COPY public ./public

EXPOSE 3000

ENV NODE_ENV=production

CMD ["npm", "run", "start:http"]
