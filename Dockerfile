# One image, four services. The command selects the service (see docker-compose.yml).
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY public ./public
COPY Mobile_Provider_Billing_Guide.md ./
USER node
EXPOSE 3000 3001 3002 3003
CMD ["node", "dist/api/main.js"]
