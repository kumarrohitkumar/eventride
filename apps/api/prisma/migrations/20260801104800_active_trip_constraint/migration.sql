-- INV-5 ("one active trip per driver") enforced by the DATABASE, not by application code.
--
-- Postgres would express this as a partial unique index:
--     UNIQUE (driver_id) WHERE state IN ('OFFERED','ACCEPTED','EN_ROUTE','AT_PICKUP','ON_TRIP')
--
-- MySQL has no partial indexes. The equivalent is a generated column that holds the driver id while
-- the trip is active and NULL otherwise, plus a plain UNIQUE index on it — MySQL permits unlimited
-- NULLs in a unique index, so completed and rejected trips never collide.
--
-- WHY VIRTUAL AND NOT STORED:
-- `trip.driver_id` carries a foreign key with ON UPDATE CASCADE (Prisma's default). MySQL refuses to
-- add a STORED generated column derived from such a column, reporting the misleading
-- "ERROR 1215 (HY000): Cannot add foreign key constraint". A VIRTUAL column is accepted, and MySQL 8
-- fully supports a secondary UNIQUE index on a virtual column, so the constraint is enforced
-- identically. The value is computed on read instead of materialised, which costs nothing here:
-- nothing ever SELECTs this column — it exists solely to carry the index.
--
-- Prisma cannot express generated columns in its schema language, so this migration is hand-written
-- and `activeDriverId` is treated as read-only in application code (stripped before every write).
--
-- Effect: two concurrent matching rounds physically cannot double-book a driver. A bug in the
-- applier surfaces as a duplicate-key error instead of stranding a guest in a phantom trip.

ALTER TABLE `trip` DROP COLUMN `active_driver_id`;

ALTER TABLE `trip`
  ADD COLUMN `active_driver_id` CHAR(36)
    GENERATED ALWAYS AS (
      IF(
        `state` IN ('OFFERED', 'ACCEPTED', 'EN_ROUTE', 'AT_PICKUP', 'ON_TRIP'),
        `driver_id`,
        NULL
      )
    ) VIRTUAL;

CREATE UNIQUE INDEX `uniq_driver_active_trip` ON `trip` (`active_driver_id`);
