-- One-time MySQL database & user setup for TTBS Live News Feed.
-- When running with Docker Compose, this is handled automatically via environment variables.
-- If configuring an external/standalone MySQL 8.0+ server, run this as the root user:

CREATE DATABASE IF NOT EXISTS ttbs_newsfeed
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'ttbs'@'%' IDENTIFIED BY 'ttbs_password';
GRANT ALL PRIVILEGES ON ttbs_newsfeed.* TO 'ttbs'@'%';
FLUSH PRIVILEGES;

