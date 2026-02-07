FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY logo.png ./

EXPOSE 8080

USER 1001

CMD ["node", "--expose-gc", "server.js"]
