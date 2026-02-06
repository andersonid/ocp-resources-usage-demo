FROM node:20-alpine

WORKDIR /app

COPY backend/package.json ./
RUN npm install --production

COPY backend/server.js ./
COPY frontend/ ./frontend/

EXPOSE 8080

USER 1001

CMD ["node", "server.js"]
