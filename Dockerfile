FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

# Persistent volume directory for WhatsApp auth credentials and 2-day cooldown state
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

CMD ["npm", "start"]
