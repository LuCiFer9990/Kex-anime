FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
COPY . .
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/app/data/ani-cli-web.sqlite ANIPY_API_URL=http://127.0.0.1:8000
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "/opt/venv/bin/uvicorn anipy_bridge:app --host 127.0.0.1 --port 8000 & exec npm start"]
