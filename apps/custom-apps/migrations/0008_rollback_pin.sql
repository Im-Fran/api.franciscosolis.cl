-- A failed maintenance whose release is shared with other devices sends only its own targets back:
-- the version a target returns to, honoured by the offer as a mandatory rollback (nullable, no default).
ALTER TABLE `installations` ADD `rollback_to_version` text;