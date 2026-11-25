-- What the writer of check 05 needs beyond console/db/schema.sql (round two).

-- One row per data point already counted. key is the first 16 bytes of the SHA-256 of the
-- point's identity; point_day is the UTC day of its TimeUnixNano, so keys expire by day;
-- numbers is a hash of the point's values, which tells a redelivery from a second point
-- that wrongly carries the same identity.
CREATE TABLE IF NOT EXISTS usage_signals.api_point_key (
  point_day  date    NOT NULL,
  key        uuid    NOT NULL,
  numbers    integer NOT NULL,
  PRIMARY KEY (point_day, key)
);

-- Points the writer refused for good, per tenant, UTC day and reason. The collector has
-- answered the tenant 200 before the writer sees a point, so this is where a refusal shows.
CREATE TABLE IF NOT EXISTS usage_signals.api_refusal (
  tenant_id  uuid   NOT NULL,
  day        date   NOT NULL,
  reason     text   NOT NULL,
  points     bigint NOT NULL CHECK (points > 0),
  PRIMARY KEY (tenant_id, day, reason)
);
