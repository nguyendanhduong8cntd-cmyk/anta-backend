-- New members must accept an invitation before reading or writing conversation content.
ALTER TABLE chat.members ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE'
  CHECK(status IN ('ACTIVE','INVITED','LEFT'));
CREATE INDEX chat_active_members ON chat.members(conversation_id,user_id) WHERE status='ACTIVE';
