-- After-the-fact review. In shadow mode nothing is held, so nothing is verified; the security team
-- labels requests afterwards so false-alarm rates can be measured before enforcing.
ALTER TABLE verifications
  ADD COLUMN kind text NOT NULL DEFAULT 'callback' CHECK (kind IN ('callback', 'review'));
