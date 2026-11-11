FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV DATA_DIR=/app/data

CMD ["npm", "start"]
