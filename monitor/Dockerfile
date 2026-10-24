# Build from the repository root: docker compose -f monitor/compose.yaml up -d --build
FROM node:22-alpine
WORKDIR /app
COPY app/js app/js
COPY app/service app/service
COPY monitor/check.js monitor/check.js
ENV DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
ENTRYPOINT ["node", "monitor/check.js"]
CMD ["loop"]
