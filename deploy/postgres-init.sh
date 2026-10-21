#!/bin/sh
# Runs once, on first start of an empty Postgres volume. The app connects as a non-superuser owner;
# migrations create the restricted shield_app role that tenant work runs under.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE USER shield_owner PASSWORD '${SHIELD_DB_PASSWORD}' CREATEROLE;
CREATE DATABASE shield OWNER shield_owner;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname shield -c "ALTER SCHEMA public OWNER TO shield_owner"
