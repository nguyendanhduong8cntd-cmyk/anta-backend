-- Sports a venue advertises beyond the ones its yards are booked for.
-- A venue can list a sport (for example "multi-sport") without publishing a price list for it, so searching
-- by sport matches either an active yard of that sport or an advertised sport.
CREATE TABLE catalog.branch_sports (
  branch_id uuid NOT NULL REFERENCES catalog.branches, sport_id uuid NOT NULL REFERENCES catalog.sports,
  PRIMARY KEY(branch_id,sport_id)
);
CREATE INDEX ON catalog.branch_sports(sport_id);
