FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY --chown=node:node server ./server
COPY --chown=node:node src/collaboration/shared.ts src/collaboration/structured.ts ./src/collaboration/
COPY --chown=node:node src/editor/model/types.ts src/editor/model/data.ts ./src/editor/model/
USER node
ENV HOST=0.0.0.0 PORT=8787 LIGHT_PEN_DATA=/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","--import","tsx","server/main.ts"]
