CREATE SEQUENCE anchor_sync_order_seq AS BIGINT;

ALTER TABLE anchors
  ADD COLUMN last_sync_order BIGINT NOT NULL DEFAULT 0;
