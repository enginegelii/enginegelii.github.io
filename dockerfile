FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# package.json ve package-lock.json'u kopyala
COPY package*.json ./
RUN npm ci --omit=dev

# Tüm dosyaları kopyala
COPY . .

# Non-root kullanıcı ekle
RUN addgroup -S app && adduser -S app -G app
USER app

# Uygulama portu
EXPOSE 8787

# Sağlık kontrolü
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/_diag >/dev/null 2>&1 || exit 1

# Çalıştırma komutu
CMD ["node", "server.js"]
