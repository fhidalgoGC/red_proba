# Contenedor del cliente — track C. Firma, cifra y publica.
# INVARIANTE: firma y cifra, pero NUNCA descifra. Vive en las policies de KMS.
#
# Se compila con `tsc` y no con `nest build`: c3 no tiene nest-cli.json, su
# build es el compilador a secas (ver package.json).
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# El healthCheck de la task definition usa `wget -qO- localhost:8080/health`.
# No se instala nada para eso: el wget de busybox ya viene en la imagen.
EXPOSE 8080
CMD ["node", "dist/main.js"]
