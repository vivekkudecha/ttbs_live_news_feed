# Gateway: the single entry point (see conf.d/default.conf). Runs as an unprivileged user (uid 101)
# on port 8080, with configuration baked in, so the running container needs no writable config and
# works the same on any host (bind-mounted files would depend on the host's umask).
FROM docker.io/nginxinc/nginx-unprivileged:1.30.6-alpine

# true = also route /phpmyadmin/ and /docs (dev, uat). Prod builds leave it false.
ARG WITH_TOOLS=false

USER root
COPY conf.d/ /etc/nginx/conf.d/
COPY snippets/ /etc/nginx/snippets/
COPY extra/ /tmp/extra/
COPY docker-entrypoint.d/40-basic-auth.sh /docker-entrypoint.d/40-basic-auth.sh
# COPY keeps host modes; normalise so uid 101 can read everything (and strip CRLF from scripts).
RUN mkdir -p /etc/nginx/extra \
    && if [ "$WITH_TOOLS" = "true" ]; then cp /tmp/extra/*.conf /etc/nginx/extra/; fi \
    && rm -rf /tmp/extra \
    && sed -i 's/\r$//' /docker-entrypoint.d/40-basic-auth.sh \
    && chmod -R a+rX /etc/nginx \
    && chmod 755 /docker-entrypoint.d/40-basic-auth.sh
USER 101

EXPOSE 8080
