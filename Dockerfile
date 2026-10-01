# Kaynakça Masası images. No npm dependencies: the code is copied as is.
#   service: queue and LLM services (node only)
#   python:  verification service (adds Python + pypdf for full-text PDFs)
#   web:     the web application (Python + pypdf for Word/PDF manuscripts)
FROM node:24-alpine AS service
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data
USER node
# Each container chooses its service with its command (see docker-compose.yml).
CMD ["node", "services/queue/server.cjs"]

FROM service AS python
USER root
RUN apk add --no-cache python3 py3-pip \
 && pip install --no-cache-dir --break-system-packages "pypdf>=6,<7"
USER node
ENV WORD_PYTHON=python3
CMD ["node", "services/verify/index.cjs"]

FROM python AS web
USER root
RUN mkdir -p /data/word && chown -R node:node /data
USER node
ENV WORD_ARCHIVE_DIR=/data/word HOST=0.0.0.0 PORT=4173
EXPOSE 4173
CMD ["node", "server.cjs"]
