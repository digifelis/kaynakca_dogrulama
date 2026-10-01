# Kaynakça Masası images. No npm dependencies: the code is copied as is.
#   service: queue, verification and LLM services (node only)
#   web:     the web application (adds Python + pypdf for Word/PDF handling)
FROM node:24-alpine AS service
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data
USER node
# Each container chooses its service with its command (see docker-compose.yml).
CMD ["node", "services/queue/server.cjs"]

FROM service AS web
USER root
RUN apk add --no-cache python3 py3-pip \
 && pip install --no-cache-dir --break-system-packages pypdf==5.* \
 && mkdir -p /data/word && chown -R node:node /data
USER node
ENV WORD_PYTHON=python3 WORD_ARCHIVE_DIR=/data/word HOST=0.0.0.0 PORT=4173
EXPOSE 4173
CMD ["node", "server.cjs"]
