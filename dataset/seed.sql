-- Skewed shop data: 200k customers, 1M orders (power-law per customer).
SELECT setseed(0.42);
CREATE TABLE customers (
  id int PRIMARY KEY,
  email text NOT NULL,
  region text NOT NULL,
  created_at timestamptz NOT NULL
);
INSERT INTO customers
SELECT g, 'customer' || g || '@example.com',
       CASE WHEN r < 0.3 THEN 'eu' WHEN r < 0.7 THEN 'us' WHEN r < 0.9 THEN 'apac' ELSE 'latam' END,
       timestamptz '2026-10-30' - random() * interval '1000 days'
FROM (SELECT g, random() AS r FROM generate_series(1, 200000) g) s;

CREATE TABLE orders (
  id bigint PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers,
  status text NOT NULL,
  amount numeric(10,2) NOT NULL,
  created_at timestamptz NOT NULL
);
INSERT INTO orders
SELECT g, 1 + floor(200000 * random() ^ 2)::int,
       CASE WHEN r < 0.85 THEN 'paid' WHEN r < 0.93 THEN 'shipped' WHEN r < 0.98 THEN 'cancelled' ELSE 'pending' END,
       round((5 + random() * 495)::numeric, 2),
       timestamptz '2026-10-30' - random() * interval '730 days'
FROM (SELECT g, random() AS r FROM generate_series(1, 1000000) g) s;

ANALYZE;
CHECKPOINT;
