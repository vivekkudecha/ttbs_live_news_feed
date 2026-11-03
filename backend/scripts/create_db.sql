-- One-time setup. Run as the postgres superuser:
--   "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -f scripts/create_db.sql
-- Replace CHANGE_ME with a real password, and put the same value in backend/.env DATABASE_URL.
CREATE ROLE ttbs LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE ttbs_newsfeed OWNER ttbs ENCODING 'UTF8';
