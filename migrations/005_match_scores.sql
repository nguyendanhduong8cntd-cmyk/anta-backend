ALTER TABLE social.matches ADD COLUMN home_score integer CHECK(home_score>=0);
ALTER TABLE social.matches ADD COLUMN away_score integer CHECK(away_score>=0);
ALTER TABLE social.matches ADD CONSTRAINT finished_match_has_score
  CHECK(status<>'FINISHED' OR (home_score IS NOT NULL AND away_score IS NOT NULL));
CREATE INDEX ON social.matches(event_id,status);
