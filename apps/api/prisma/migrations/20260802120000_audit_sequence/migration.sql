-- Deterministic ordering for the append-only audit trail.
--
-- `at` alone is not sufficient: several transitions inside one transaction share the same
-- millisecond (and under a virtual clock in tests, an entire lifecycle can), so ordering by
-- timestamp leaves the sequence ambiguous — which defeats the purpose of an audit log whose job is
-- to say who did what IN WHICH ORDER.
--
-- Hand-written because Prisma emits a plain `ADD COLUMN seq INT NOT NULL` with no default, which
-- MySQL rejects on a table that already has rows. AUTO_INCREMENT backfills existing rows instead,
-- and MySQL permits it on a non-primary-key column provided that column is indexed — the UNIQUE
-- index satisfies that requirement.

ALTER TABLE `status_event`
  ADD COLUMN `seq` INT NOT NULL AUTO_INCREMENT,
  ADD UNIQUE INDEX `status_event_seq_key` (`seq`);

CREATE INDEX `status_event_seq_idx` ON `status_event` (`seq`);
