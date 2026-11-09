# Fully qualified image names: Podman on RHEL refuses ambiguous short names in non-interactive builds.

# Stage 1: Build the Vite React application
FROM docker.io/library/node:24-alpine AS builder

WORKDIR /app

# Install dependencies based on lockfile
COPY package.json package-lock.json ./
RUN npm ci

# Copy application source code
COPY . .

# Backend API base URL as seen by the browser. "/" = same origin: nginx below proxies /api/ to the
# backend, so the bundle works on any host name/IP without rebuilding.
ARG VITE_API_URL=/
ENV VITE_API_URL=${VITE_API_URL}

# Build static assets
RUN npm run build

# Stage 2: Serve the static build with nginx, as an unprivileged user (uid 101) on port 8080.
FROM docker.io/nginxinc/nginx-unprivileged:1.30.6-alpine

USER root
RUN rm -rf /usr/share/nginx/html/*
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# COPY keeps host modes (e.g. umask 027 -> rw-r-----): make it all readable by the nginx user.
RUN chmod -R a+rX /usr/share/nginx/html /etc/nginx/conf.d
USER 101

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
