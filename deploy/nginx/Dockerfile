# Gateway image = the built SPA + one nginx (nginx.conf). Build context: the repository root.
# Fully qualified image names: Podman on RHEL refuses short names in non-interactive builds.

# Stage 1: build the React SPA. VITE_API_URL "/" = same origin, so the bundle works on any host.
FROM docker.io/library/node:24-alpine AS spa
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ENV VITE_API_URL=/
RUN npm run build

# Stage 2: nginx as an unprivileged user (uid 101) on port 8080, config baked in.
FROM docker.io/nginxinc/nginx-unprivileged:1.30.6-alpine
# true = also route /phpmyadmin/ and /docs (dev, uat). Prod leaves it false.
ARG WITH_TOOLS=false

USER root
RUN rm -rf /usr/share/nginx/html/*
COPY --from=spa /app/dist /usr/share/nginx/html
COPY deploy/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/nginx/headers.conf deploy/nginx/tools.conf /etc/nginx/
COPY deploy/nginx/40-basic-auth.sh /docker-entrypoint.d/40-basic-auth.sh
# COPY keeps host modes (umask 027 -> rw-r-----): make everything readable by uid 101,
# strip CRLF from the script (Windows checkouts), drop tools.conf from prod images.
RUN if [ "$WITH_TOOLS" != "true" ]; then rm /etc/nginx/tools.conf; fi \
    && sed -i 's/\r$//' /docker-entrypoint.d/40-basic-auth.sh \
    && chmod -R a+rX /usr/share/nginx/html /etc/nginx \
    && chmod 755 /docker-entrypoint.d/40-basic-auth.sh
USER 101

EXPOSE 8080
