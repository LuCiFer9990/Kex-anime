FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/app/data/ani-cli-web.sqlite
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
