FROM node:18-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    ZWY_ROOT=/app

# 只复制运行必需的脚本, 不复制 accounts.json / .state 等凭据文件
COPY scripts/zwy.js /app/scripts/zwy.js
COPY http/server.js /app/http/server.js
COPY http/mcp.js /app/http/mcp.js
COPY http/app.html /app/http/app.html

RUN mkdir -p /app/scripts/.state && chown -R node:node /app

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health > /dev/null || exit 1

CMD ["node", "/app/http/server.js"]
