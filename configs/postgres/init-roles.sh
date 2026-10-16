#!/bin/sh
# Runs once, when the database volume is first created (docker-entrypoint-initdb.d).
# Creates the least-privilege application role and the test database.
# Table grants for anpr_app are applied by the Alembic migration, which knows the tables.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE anpr_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
REVOKE ALL ON DATABASE anpr FROM PUBLIC;
GRANT CONNECT ON DATABASE anpr TO anpr_app;
CREATE DATABASE anpr_test OWNER anpr_owner;
GRANT CONNECT ON DATABASE anpr_test TO anpr_app;
SQL
