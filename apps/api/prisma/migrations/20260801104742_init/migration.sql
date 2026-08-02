-- CreateTable
CREATE TABLE `event` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'Asia/Kolkata',
    `starts_at` DATETIME(3) NOT NULL,
    `ends_at` DATETIME(3) NOT NULL,
    `config` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `location` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('AIRPORT', 'STATION', 'ACCOMMODATION', 'VENUE', 'CUSTOM') NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `lat` DOUBLE NOT NULL,
    `lng` DOUBLE NOT NULL,
    `pickup_instruction` TEXT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `location_type_idx`(`type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_user` (
    `id` VARCHAR(191) NOT NULL,
    `role` ENUM('ADMIN', 'DRIVER', 'GUEST') NOT NULL,
    `phone` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `password_hash` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `app_user_phone_key`(`phone`),
    UNIQUE INDEX `app_user_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `guest` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `group_size` INTEGER NOT NULL,
    `luggage_count` INTEGER NOT NULL,
    `accommodation_id` VARCHAR(191) NULL,
    `arrival_mode` VARCHAR(191) NULL,
    `arrival_ref` VARCHAR(191) NULL,
    `arrival_at` DATETIME(3) NULL,
    `arrival_location_id` VARCHAR(191) NULL,
    `departure_mode` VARCHAR(191) NULL,
    `departure_ref` VARCHAR(191) NULL,
    `departure_at` DATETIME(3) NULL,
    `departure_location_id` VARCHAR(191) NULL,
    `is_vip` BOOLEAN NOT NULL DEFAULT false,
    `notes` TEXT NULL,
    `is_walk_in` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `guest_user_id_key`(`user_id`),
    INDEX `guest_accommodation_id_idx`(`accommodation_id`),
    INDEX `guest_arrival_at_idx`(`arrival_at`),
    INDEX `guest_is_vip_idx`(`is_vip`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `driver` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `vehicle_number` VARCHAR(191) NOT NULL,
    `vehicle_type` VARCHAR(191) NOT NULL,
    `seat_capacity` INTEGER NOT NULL,
    `luggage_capacity` INTEGER NOT NULL,
    `shift_start` DATETIME(3) NOT NULL,
    `shift_end` DATETIME(3) NOT NULL,
    `state` ENUM('OFFLINE', 'AVAILABLE', 'OFFERED', 'EN_ROUTE_TO_PICKUP', 'AT_PICKUP', 'ON_TRIP', 'ON_BREAK', 'UNAVAILABLE') NOT NULL DEFAULT 'OFFLINE',
    `last_lat` DOUBLE NULL,
    `last_lng` DOUBLE NULL,
    `last_location_at` DATETIME(3) NULL,
    `predicted_free_at` DATETIME(3) NULL,
    `predicted_free_lat` DOUBLE NULL,
    `predicted_free_lng` DOUBLE NULL,
    `driving_minutes_today` INTEGER NOT NULL DEFAULT 0,
    `trips_since_break` INTEGER NOT NULL DEFAULT 0,
    `break_state` ENUM('NONE', 'DUE', 'ON_BREAK') NOT NULL DEFAULT 'NONE',
    `break_started_at` DATETIME(3) NULL,
    `unavailable_reason` VARCHAR(191) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `driver_user_id_key`(`user_id`),
    INDEX `driver_state_idx`(`state`),
    INDEX `driver_predicted_free_at_idx`(`predicted_free_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trip_request` (
    `id` VARCHAR(191) NOT NULL,
    `guest_id` VARCHAR(191) NOT NULL,
    `trip_type` ENUM('ARRIVAL', 'TO_VENUE', 'FROM_VENUE', 'DEPARTURE', 'AD_HOC') NOT NULL,
    `source` ENUM('SCHEDULED', 'WAVE', 'ON_DEMAND') NOT NULL,
    `origin_id` VARCHAR(191) NOT NULL,
    `destination_id` VARCHAR(191) NOT NULL,
    `origin_lat` DOUBLE NULL,
    `origin_lng` DOUBLE NULL,
    `scheduled_at` DATETIME(3) NULL,
    `ready_at` DATETIME(3) NULL,
    `deadline_at` DATETIME(3) NULL,
    `is_hard_deadline` BOOLEAN NOT NULL DEFAULT false,
    `group_size` INTEGER NOT NULL,
    `luggage_count` INTEGER NOT NULL,
    `state` ENUM('REGISTERED', 'PENDING_APPROVAL', 'APPROVED', 'DECLINED', 'QUEUED', 'ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED_PICKUP', 'BOARDED', 'COMPLETED', 'UNMATCHED', 'NO_SHOW', 'CANCELLED') NOT NULL DEFAULT 'REGISTERED',
    `priority_score` DOUBLE NOT NULL DEFAULT 0,
    `passed_over_count` INTEGER NOT NULL DEFAULT 0,
    `requeue_count` INTEGER NOT NULL DEFAULT 0,
    `unmatched_reason` VARCHAR(191) NULL,
    `group_ref` VARCHAR(191) NULL,
    `wave_id` VARCHAR(191) NULL,
    `trip_id` VARCHAR(191) NULL,
    `approval_note` TEXT NULL,
    `decline_reason` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `trip_request_state_idx`(`state`),
    INDEX `trip_request_state_ready_at_idx`(`state`, `ready_at`),
    INDEX `trip_request_guest_id_idx`(`guest_id`),
    INDEX `trip_request_wave_id_idx`(`wave_id`),
    INDEX `trip_request_trip_id_idx`(`trip_id`),
    INDEX `trip_request_group_ref_idx`(`group_ref`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trip` (
    `id` VARCHAR(191) NOT NULL,
    `driver_id` VARCHAR(191) NOT NULL,
    `state` ENUM('OFFERED', 'ACCEPTED', 'EN_ROUTE', 'AT_PICKUP', 'ON_TRIP', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'OFFERED',
    `offered_at` DATETIME(3) NULL,
    `accepted_at` DATETIME(3) NULL,
    `started_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `offer_expires_at` DATETIME(3) NULL,
    `seats_used` INTEGER NOT NULL DEFAULT 0,
    `luggage_used` INTEGER NOT NULL DEFAULT 0,
    `planned_pickup_at` DATETIME(3) NULL,
    `planned_drop_at` DATETIME(3) NULL,
    `score_breakdown` JSON NULL,
    `runner_up_driver_id` VARCHAR(191) NULL,
    `decision_round_id` VARCHAR(191) NULL,
    `is_pinned` BOOLEAN NOT NULL DEFAULT false,
    `override_reason` TEXT NULL,
    `reject_reason` TEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `active_driver_id` VARCHAR(191) NULL,

    INDEX `trip_driver_id_idx`(`driver_id`),
    INDEX `trip_state_idx`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trip_stop` (
    `id` VARCHAR(191) NOT NULL,
    `trip_id` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `kind` ENUM('PICKUP', 'DROP') NOT NULL,
    `request_id` VARCHAR(191) NOT NULL,
    `location_id` VARCHAR(191) NOT NULL,
    `lat` DOUBLE NOT NULL,
    `lng` DOUBLE NOT NULL,
    `state` ENUM('PENDING', 'ARRIVED', 'DONE', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `planned_at` DATETIME(3) NULL,
    `arrived_at` DATETIME(3) NULL,
    `departed_at` DATETIME(3) NULL,
    `seats_delta` INTEGER NOT NULL,
    `luggage_delta` INTEGER NOT NULL,

    INDEX `trip_stop_request_id_idx`(`request_id`),
    UNIQUE INDEX `trip_stop_trip_id_seq_key`(`trip_id`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wave` (
    `id` VARCHAR(191) NOT NULL,
    `trip_type` ENUM('ARRIVAL', 'TO_VENUE', 'FROM_VENUE', 'DEPARTURE', 'AD_HOC') NOT NULL,
    `origin_id` VARCHAR(191) NOT NULL,
    `destination_id` VARCHAR(191) NOT NULL,
    `departs_at` DATETIME(3) NOT NULL,
    `state` ENUM('PLANNED', 'DISPATCHED', 'CLOSED') NOT NULL DEFAULT 'PLANNED',
    `seats_needed` INTEGER NOT NULL DEFAULT 0,
    `seats_assigned` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `wave_state_departs_at_idx`(`state`, `departs_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `status_event` (
    `id` VARCHAR(191) NOT NULL,
    `entity_type` VARCHAR(191) NOT NULL,
    `entity_id` VARCHAR(191) NOT NULL,
    `from_state` VARCHAR(191) NULL,
    `to_state` VARCHAR(191) NOT NULL,
    `actor` ENUM('ENGINE', 'ADMIN', 'DRIVER', 'GUEST', 'SYSTEM') NOT NULL,
    `actor_user_id` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `meta` JSON NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `status_event_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    INDEX `status_event_at_idx`(`at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `decision_round` (
    `id` VARCHAR(191) NOT NULL,
    `trigger` VARCHAR(191) NOT NULL,
    `started_at` DATETIME(3) NOT NULL,
    `duration_ms` INTEGER NOT NULL,
    `snapshot_digest` VARCHAR(191) NULL,
    `decisions` JSON NOT NULL,
    `rejections` JSON NOT NULL,
    `routing_calls` INTEGER NOT NULL DEFAULT 0,

    INDEX `decision_round_started_at_idx`(`started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `alert` (
    `id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `severity` VARCHAR(191) NOT NULL,
    `entity_type` VARCHAR(191) NULL,
    `entity_id` VARCHAR(191) NULL,
    `message` TEXT NOT NULL,
    `meta` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acknowledged_at` DATETIME(3) NULL,
    `acknowledged_by` VARCHAR(191) NULL,

    INDEX `alert_type_acknowledged_at_idx`(`type`, `acknowledged_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `driver_position_history` (
    `id` VARCHAR(191) NOT NULL,
    `driver_id` VARCHAR(191) NOT NULL,
    `lat` DOUBLE NOT NULL,
    `lng` DOUBLE NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `driver_position_history_driver_id_at_idx`(`driver_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `otp_code` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `code_hash` VARCHAR(191) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `otp_code_phone_expires_at_idx`(`phone`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_token` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `notification_token_token_key`(`token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `guest` ADD CONSTRAINT `guest_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `guest` ADD CONSTRAINT `guest_accommodation_id_fkey` FOREIGN KEY (`accommodation_id`) REFERENCES `location`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `guest` ADD CONSTRAINT `guest_arrival_location_id_fkey` FOREIGN KEY (`arrival_location_id`) REFERENCES `location`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `guest` ADD CONSTRAINT `guest_departure_location_id_fkey` FOREIGN KEY (`departure_location_id`) REFERENCES `location`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `driver` ADD CONSTRAINT `driver_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_request` ADD CONSTRAINT `trip_request_guest_id_fkey` FOREIGN KEY (`guest_id`) REFERENCES `guest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_request` ADD CONSTRAINT `trip_request_origin_id_fkey` FOREIGN KEY (`origin_id`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_request` ADD CONSTRAINT `trip_request_destination_id_fkey` FOREIGN KEY (`destination_id`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_request` ADD CONSTRAINT `trip_request_wave_id_fkey` FOREIGN KEY (`wave_id`) REFERENCES `wave`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_request` ADD CONSTRAINT `trip_request_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip` ADD CONSTRAINT `trip_driver_id_fkey` FOREIGN KEY (`driver_id`) REFERENCES `driver`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_stop` ADD CONSTRAINT `trip_stop_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_stop` ADD CONSTRAINT `trip_stop_request_id_fkey` FOREIGN KEY (`request_id`) REFERENCES `trip_request`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_stop` ADD CONSTRAINT `trip_stop_location_id_fkey` FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wave` ADD CONSTRAINT `wave_origin_id_fkey` FOREIGN KEY (`origin_id`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wave` ADD CONSTRAINT `wave_destination_id_fkey` FOREIGN KEY (`destination_id`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `driver_position_history` ADD CONSTRAINT `driver_position_history_driver_id_fkey` FOREIGN KEY (`driver_id`) REFERENCES `driver`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_token` ADD CONSTRAINT `notification_token_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
