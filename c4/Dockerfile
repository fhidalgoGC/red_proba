# Consumidor de C4 — track G. El operador neutro.
# INVARIANTE: descifra pero nunca firma. Vive en las policies de KMS, no aqui.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npx nest build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Sin EXPOSE: C4 no escucha en ningun puerto. Su entrada es la cola.
CMD ["node", "dist/main.js"]
