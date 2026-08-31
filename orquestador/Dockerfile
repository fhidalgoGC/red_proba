# Orquestador de carga — track O. Es andamio: desaparece con la prueba.
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
# config/ se monta o se hornea segun el entorno; ver ORQ_CONFIG_DIR
COPY config ./config
EXPOSE 3000
CMD ["node", "dist/main.js"]
