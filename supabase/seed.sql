-- SAMPLE data for development and testing only. Do not run in production:
-- PGBX enters real dealers, stock and vault counts through the admin panel.
insert into dealers (id, name, area, address, phone, lat, lng, hours) values
  ('d1', 'Saddar Bullion Counter', 'Saddar, Karachi', 'Sample address', '+92 21 0000 0101', 24.8566, 67.0272, '10:00 – 20:00'),
  ('d2', 'Clifton Gold Desk', 'Clifton Block 5, Karachi', 'Sample address', '+92 21 0000 0102', 24.8170, 67.0300, '11:00 – 21:00'),
  ('d3', 'Gulshan Sarafa Point', 'Gulshan-e-Iqbal, Karachi', 'Sample address', '+92 21 0000 0103', 24.9200, 67.0950, '10:30 – 19:30'),
  ('d4', 'Tariq Road Metals', 'PECHS, Karachi', 'Sample address', '+92 21 0000 0104', 24.8720, 67.0610, '12:00 – 22:00');

insert into dealer_stock (dealer_id, product_id, units)
select d.id, p.id, case when (d.id, p.id) in (('d2', 's-1t'), ('d2', 's-10t'), ('d2', 'g-5g'), ('d3', 'g-1g'), ('d3', 's-3t'), ('d4', 'g-10mg'), ('d4', 's-5t')) then 0 else 6 end
from dealers d cross join products p;

insert into vault_counts (product_id, units, counted_by, note)
select id, 500, 'seed', 'Sample opening count' from products;
