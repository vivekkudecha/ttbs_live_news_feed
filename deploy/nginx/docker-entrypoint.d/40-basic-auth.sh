#!/bin/sh
# Writes the phpMyAdmin gate's htpasswd from GATEWAY_PMA_HTPASSWD (a "user:$2y$..." bcrypt line)
# into tmpfs. Unset = a file with no valid user: the gate refuses everyone.
set -eu
mkdir -p /tmp/auth
umask 077
printf '%s\n' "${GATEWAY_PMA_HTPASSWD:-locked:!}" > /tmp/auth/phpmyadmin.htpasswd
