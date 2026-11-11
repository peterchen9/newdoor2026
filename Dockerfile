FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY public ./public
RUN mkdir -p /data /door_photo && chown -R node:node /data /door_photo
USER node
EXPOSE 3900
CMD ["node", "server.mjs"]
