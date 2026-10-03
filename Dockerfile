# Kaynakça Masası images. npm dependencies (ldapts for directory sign-in, nodemailer for e-mail) are installed once in the base stage.
#   service: queue and LLM services (node only)
#   python:  verification service (adds Python + pypdf for full-text PDFs)
#   web:     the web application (Python + pypdf for Word/PDF manuscripts; writing assistant data in /data/writer)
FROM node:24-alpine AS service
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
RUN mkdir -p /data/llm && chown -R node:node /data
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
RUN mkdir -p /data/word /data/writer && chown -R node:node /data
USER node
ENV WORD_ARCHIVE_DIR=/data/word WRITER_DATA_DIR=/data/writer HOST=0.0.0.0 PORT=4173
EXPOSE 4173
CMD ["node", "server.cjs"]
