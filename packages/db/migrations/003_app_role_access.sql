-- On a real Postgres server the connecting (owner) role is not a superuser, so it must be a member
-- of shield_app to SET ROLE to it, and shield_app needs USAGE on whichever schema holds the tables.
-- (PGlite runs as a superuser, which hid both.)
GRANT shield_app TO CURRENT_USER;

DO $$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO shield_app', current_schema());
END $$;
