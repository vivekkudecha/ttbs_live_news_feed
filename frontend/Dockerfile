# Fully qualified image names: Podman on RHEL refuses ambiguous short names in non-interactive builds.

# Stage 1: Build the Vite React application
FROM docker.io/library/node:20-alpine AS builder

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

# Stage 2: Serve application with Nginx
FROM docker.io/library/nginx:1.27-alpine

# Remove default nginx static html files
RUN rm -rf /usr/share/nginx/html/*

# Copy built distribution from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
