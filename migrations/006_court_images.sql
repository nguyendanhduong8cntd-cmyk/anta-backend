-- Court photos are owned by a branch, optionally scoped to one yard.
-- Source uploads stay in quarantine; sanitized WebP copies are the only public objects.
ALTER TABLE media.uploads ADD COLUMN purpose text NOT NULL DEFAULT 'GENERAL'
  CHECK (purpose IN ('GENERAL','COURT'));
ALTER TABLE media.uploads ADD COLUMN branch_id uuid REFERENCES catalog.branches;
ALTER TABLE media.uploads ADD COLUMN yard_id uuid REFERENCES catalog.yards;
ALTER TABLE media.uploads ADD COLUMN source_key text;
ALTER TABLE media.uploads ADD COLUMN width integer CHECK (width > 0);
ALTER TABLE media.uploads ADD COLUMN height integer CHECK (height > 0);
ALTER TABLE media.uploads ADD COLUMN archived_at timestamptz;
ALTER TABLE media.uploads ADD CONSTRAINT court_upload_scope CHECK (
  (purpose = 'GENERAL' AND branch_id IS NULL AND yard_id IS NULL) OR
  (purpose = 'COURT' AND branch_id IS NOT NULL)
);
ALTER TABLE catalog.yards ADD CONSTRAINT yards_id_branch_unique UNIQUE(id,branch_id);
ALTER TABLE media.uploads ADD CONSTRAINT court_upload_yard_branch_fk
  FOREIGN KEY(yard_id,branch_id) REFERENCES catalog.yards(id,branch_id);
CREATE INDEX media_court_images_branch ON media.uploads(branch_id,status,created_at)
  WHERE purpose='COURT' AND archived_at IS NULL;
